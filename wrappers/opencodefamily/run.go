// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"sync"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/sessionbus/peer-common/host"
)

type laneRun struct {
	run       *kit.Run
	initial   string
	original  *httpOperation
	started   chan struct{}
	startOnce sync.Once
	userSeen  bool
	count     int
	interrupt *nativeInterrupt
}
type nativeInterrupt struct {
	done chan struct{}
	err  error
	ack  bool
}

func (p *Wrapper) promptBody(id, text string) map[string]any {
	b := map[string]any{"messageID": id, "parts": []map[string]string{{"type": "text", "text": text}}}
	if p.model != nil {
		b["model"] = map[string]string{"providerID": p.model.ProviderID, "modelID": p.model.ID}
	}
	if p.agent != "" {
		b["agent"] = p.agent
	}
	return b
}
func (p *Wrapper) Run(ctx context.Context, run *kit.Run, input kit.RunInput) (kit.TurnResult, error) {
	return p.executeRun(ctx, run, input, run.ReportDelivery)
}
func (p *Wrapper) executeRun(ctx context.Context, run *kit.Run, input kit.RunInput, report func(kit.DeliveryReceipt, error) error) (kit.TurnResult, error) {
	var text string
	var err error
	if input.Delivery != nil {
		text, err = host.RenderNativeMessage(*input.Delivery)
	} else if input.Text != nil {
		text = *input.Text
	} else {
		err = errors.New("missing Run input")
	}
	if err != nil {
		return kit.TurnResult{}, err
	}
	if strings.TrimSpace(text) == "" {
		return kit.TurnResult{}, errors.New("empty native Run input")
	}
	id, err := p.nextMessageID()
	if err != nil {
		return kit.TurnResult{}, err
	}
	p.mu.Lock()
	if p.run != nil {
		select {
		case <-p.run.Done():
			p.run = nil
		default:
		}
	}
	if !p.opened || p.closing || p.ctx.Err() != nil || p.run != nil {
		p.mu.Unlock()
		return kit.TurnResult{}, p.kind.err("lane unavailable or busy")
	}
	b, err := encodeNativeFor(p.kind, p.promptBody(id, text))
	if err != nil {
		p.mu.Unlock()
		return kit.TurnResult{}, err
	}
	request, err := p.client.prepare(p.ctx, "POST", sessionPath(p.id)+"/message", b)
	if err != nil || ctx.Err() != nil {
		p.mu.Unlock()
		return kit.TurnResult{}, errors.Join(err, ctx.Err())
	}
	t := &laneRun{run: run, initial: id, started: make(chan struct{}), count: 1}
	p.run, p.active = run, t
	op, err := p.client.begin(request, 200)
	if err != nil {
		p.run, p.active = nil, nil
		p.mu.Unlock()
		return kit.TurnResult{}, err
	}
	t.original = op
	p.mu.Unlock()
	// SDK admission is ordering of our owned operation, not native consumption.
	run.Admitted()
	stop := context.AfterFunc(ctx, func() { p.fail(ctx.Err()) })
	defer stop()
	defer func() {
		p.mu.Lock()
		if p.active == t {
			p.active = nil
		}
		p.mu.Unlock()
	}()
	if run.Interrupted() {
		p.ensureInterrupt(t)
	}
	if input.Delivery != nil {
		<-op.written
		var receiptErr error
		// ReportDelivery writes on the bus connection. Native owner loss must
		// release a genuinely blocked bus write as well as native HTTP work.
		shutdownDone := make(chan struct{})
		stopShutdown := context.AfterFunc(p.ctx, func() {
			if p.shutdown != nil {
				p.shutdown()
			}
			close(shutdownDone)
		})
		if op.writeErr == nil {
			receiptErr = report(kit.DeliveryReceipt{Disposition: "written"}, nil)
		} else {
			receiptErr = report(kit.DeliveryReceipt{}, op.writeErr)
		}
		if !stopShutdown() {
			<-shutdownDone
		}
		if receiptErr != nil {
			p.fail(receiptErr)
		}
	}
	raw, err := op.wait()
	p.mu.Lock()
	interrupt := t.interrupt
	p.mu.Unlock()
	if interrupt != nil {
		<-interrupt.done
		if interrupt.err != nil {
			p.fail(interrupt.err)
			err = errors.Join(err, interrupt.err)
		}
	}
	if err != nil {
		p.fail(err)
		return kit.TurnResult{}, err
	}
	if p.ctx.Err() != nil {
		return kit.TurnResult{}, context.Cause(p.ctx)
	}
	final, err := decodeParts(raw, p.id)
	interrupted := interrupt != nil && interrupt.ack
	if err != nil {
		p.fail(err)
		return kit.TurnResult{}, err
	}
	projection, err := p.client.projectHistory(p.ctx, p.id, id, final)
	if err != nil {
		// Native cancel's lastAssistant fallback can predate the admitted input.
		// Only that exact stale-result condition permits empty interrupted output.
		if interrupted && (errors.Is(err, errPriorAssistant) || final.Info.Role != "assistant") {
			return kit.TurnResult{Outcome: "interrupted"}, nil
		}
		return kit.TurnResult{}, err
	}
	if final.Info.Summary && (len(final.Info.Error) == 0 || string(final.Info.Error) == "null") {
		if interrupted {
			return kit.TurnResult{Outcome: "interrupted", Result: projection.text}, nil
		}
		return kit.TurnResult{}, errors.New("native Run returned only an internal summary")
	}
	result := kit.TurnResult{Outcome: "completed", Result: projection.text, NativeStopReason: final.Info.Finish}
	if len(final.Info.Error) > 0 && string(final.Info.Error) != "null" {
		var cause struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(final.Info.Error, &cause) != nil || cause.Name == "" {
			return kit.TurnResult{}, errors.New("malformed native terminal error")
		}
		result.Outcome = "failed"
		result.NativeStopReason = cause.Name
		if cause.Name == "MessageAbortedError" {
			result.Outcome = "interrupted"
		}
	} else {
		complete, err := completedAssistantFor(p.kind, final)
		if err != nil {
			return kit.TurnResult{}, err
		}
		// Kilo can normally break after plan follow-up (including dismissal)
		// while the last assistant still has ordinary tools/tool-calls finish.
		// Acknowledged abort fallback is not evidence of that normal break.
		if !complete && !interrupted && p.kind == kiloNative && p.planFollowup &&
			final.Info.Time.Completed != nil && final.Info.Finish != "" &&
			projection.completedPlan && final.Info.ParentID == projection.latestUser {
			complete, err = hasNativeToolCalls(final)
			if err != nil {
				return kit.TurnResult{}, err
			}
		}
		if !complete {
			if interrupted {
				return kit.TurnResult{Outcome: "interrupted"}, nil
			}
			return kit.TurnResult{}, errors.New("native terminal lacks completed assistant")
		}
	}
	return result, nil
}

// Native prompt.ts keeps running on ordinary tool calls, even when a provider
// reports finish=stop. Provider-executed tools and cleanup-marked interrupted
// orphans are the native exceptions; error terminals take precedence above.
func completedAssistantFor(kind nativeKind, final withParts) (bool, error) {
	if final.Info.Time.Completed == nil || final.Info.Finish == "" || final.Info.Finish == "tool-calls" || (final.Info.Finish == "unknown" && kind != kiloNative) {
		return false, nil
	}
	tools, err := hasNativeToolCalls(final)
	return !tools, err
}

func hasNativeToolCalls(final withParts) (bool, error) {
	for _, raw := range final.Parts {
		var kind struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &kind) != nil {
			return false, errors.New("malformed native terminal part")
		}
		if kind.Type != "tool" {
			continue
		}
		var part struct {
			Metadata struct {
				ProviderExecuted bool `json:"providerExecuted"`
			} `json:"metadata"`
			State struct {
				Status   string `json:"status"`
				Metadata struct {
					Interrupted bool `json:"interrupted"`
				} `json:"metadata"`
			} `json:"state"`
		}
		if err := json.Unmarshal(raw, &part); err != nil {
			return false, errors.New("malformed native terminal tool metadata")
		}
		if !part.Metadata.ProviderExecuted && !(part.State.Status == "error" && part.State.Metadata.Interrupted) {
			return true, nil
		}
	}
	return false, nil
}
func (p *Wrapper) ensureInterrupt(t *laneRun) *nativeInterrupt {
	p.mu.Lock()
	defer p.mu.Unlock()
	if t.interrupt != nil {
		return t.interrupt
	}
	op := &nativeInterrupt{done: make(chan struct{})}
	t.interrupt = op
	go func() {
		defer close(op.done)
		select {
		case <-t.original.done:
			return
		case <-t.started:
		case <-p.ctx.Done():
			op.err = context.Cause(p.ctx)
			return
		}
		select {
		case <-t.original.done:
			return
		default:
		}
		r, e := p.client.prepare(p.ctx, "POST", sessionPath(p.id)+"/abort", []byte(`{}`))
		if e != nil {
			op.err = e
			return
		}
		call, e := p.client.beginControl(r, 200)
		if e != nil {
			op.err = e
			p.fail(e)
			return
		}
		b, e := call.wait()
		if e == nil && strings.TrimSpace(string(b)) != "true" {
			e = errors.New("native abort not acknowledged")
		}
		op.err = e
		op.ack = e == nil
		if e != nil {
			p.fail(e)
		}
	}()
	return op
}
func (p *Wrapper) Interrupt(ctx context.Context, run *kit.Run) error {
	p.mu.Lock()
	t := p.active
	p.mu.Unlock()
	if t == nil || t.run != run {
		return nil
	}
	op := p.ensureInterrupt(t)
	select {
	case <-op.done:
		return op.err
	case <-ctx.Done():
		p.fail(ctx.Err())
		<-op.done
		return ctx.Err()
	}
}
func (p *Wrapper) Deliver(ctx context.Context, request kit.DeliveryRequest, _ *kit.Run) (kit.DeliveryReceipt, error) {
	text, err := host.RenderNativeMessage(request)
	if err != nil {
		return kit.DeliveryReceipt{}, err
	}
	if len(text) > maxNativeRequest {
		return kit.DeliveryReceipt{Disposition: "rejected", Reason: "message_too_large"}, nil
	}
	if ctx.Err() != nil {
		return kit.DeliveryReceipt{}, ctx.Err()
	}
	// OpenCode's noReply route persists history without entering the native
	// loop, and Kilo has no active append route. Refuse before either native
	// write; the daemon retains the original delivery and wakes a fresh run.
	return kit.DeliveryReceipt{}, host.NotRunning()
}
func (p *Wrapper) observe(raw []byte) error {
	var e struct {
		Type       string          `json:"type"`
		Properties json.RawMessage `json:"properties"`
	}
	if json.Unmarshal(raw, &e) != nil || e.Type == "" {
		return errors.New("malformed native event")
	}
	// Other native events have their own payloads. Decode only the variants
	// used by this owner, after discriminating the event type.
	switch e.Type {
	case "message.updated", "session.created", "session.updated", "session.deleted", "session.status", "permission.asked", "question.asked":
	default:
		return nil
	}
	var properties struct {
		SessionID string          `json:"sessionID"`
		ID        string          `json:"id"`
		Info      json.RawMessage `json:"info"`
		Status    struct {
			Type string `json:"type"`
		} `json:"status"`
	}
	if json.Unmarshal(e.Properties, &properties) != nil {
		return errors.New("malformed native event properties")
	}
	var info nativeInfo
	switch e.Type {
	case "message.updated":
		if json.Unmarshal(properties.Info, &info) != nil || !validMessageID(info.ID) || !validNativeID(info.SessionID) || (info.Role != "user" && info.Role != "assistant") || (properties.SessionID != "" && properties.SessionID != info.SessionID) {
			return errors.New("malformed native message event")
		}
	case "session.created", "session.updated", "session.deleted":
		var session struct {
			ID      string          `json:"id"`
			Summary json.RawMessage `json:"summary"`
		}
		if json.Unmarshal(properties.Info, &session) != nil || !validNativeID(session.ID) || (properties.SessionID != "" && properties.SessionID != session.ID) {
			return errors.New("malformed native session event")
		}
		if len(session.Summary) != 0 {
			if err := validateNativeSummary(session.Summary, false); err != nil {
				return err
			}
		}
	}
	p.mu.Lock()
	t := p.active
	id := p.id
	if t != nil {
		if e.Type == "message.updated" && info.SessionID == id && info.ID == t.initial && info.Role == "user" {
			t.userSeen = true
		}
		if e.Type == "session.status" && properties.SessionID == id && properties.Status.Type == "busy" && t.userSeen {
			t.startOnce.Do(func() { close(t.started) })
		}
	}
	p.mu.Unlock()
	if e.Type != "permission.asked" && e.Type != "question.asked" {
		return nil
	}
	if !validNativeID(properties.SessionID) || properties.ID == "" {
		return errors.New("invalid native permission/question request")
	}
	// Keep the stream reader available for the ordered startup/cancel gate.
	// Native ancestry lookups and rejection responses are bounded joined work.
	if len(properties.ID) > 4096 || strings.ContainsAny(properties.ID, "\x00\r\n") {
		return errors.New("invalid native request ID")
	}
	select {
	case p.eventWork <- struct{}{}:
	default:
		return errors.New("native event work limit reached")
	}
	p.workers.Add(1)
	go func() {
		defer p.workers.Done()
		defer func() { <-p.eventWork }()
		if err := p.ownsSession(p.ctx, properties.SessionID); err != nil {
			p.fail(err)
			return
		}
		path := "/question/" + url.PathEscape(properties.ID) + "/reject"
		var body any = map[string]any{}
		if e.Type == "permission.asked" {
			path = "/permission/" + url.PathEscape(properties.ID) + "/reply"
			body = map[string]string{"reply": "reject"}
		}
		if _, err := p.client.call(p.ctx, "POST", path, body, 200); err != nil {
			p.fail(err)
		}
	}()
	return nil
}

// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	kit "github.com/antst/sessionbus/bus/sdk/go"
)

type laneInput struct{ text string }
type nativeInputRequest struct {
	Operation string `json:"operation"`
	SessionID string `json:"sessionID"`
	MessageID string `json:"messageID"`
	Created   int64  `json:"created"`
	Token     string `json:"token,omitempty"`
	After     string `json:"after,omitempty"`
}
type nativeTextPart struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionID"`
	MessageID string `json:"messageID"`
	Type      string `json:"type"`
	Text      string `json:"text"`
}

func (r nativeInputRequest) atOrAfter(anchor nativeInputRequest) bool {
	return r.Created > anchor.Created || r.Created == anchor.Created && r.MessageID >= anchor.MessageID
}

func validPartFloor(floor string) bool {
	// Adapter private-metadata/output bound, not a native PartID limit.
	if !strings.HasPrefix(floor, "prt_") || len(floor) > 256 {
		return false
	}
	for _, b := range []byte(floor) {
		if b < 33 || b > 126 {
			return false
		}
	}
	return true
}
func orderedPartID(floor string, entropy io.Reader) (string, error) {
	if !validPartFloor(floor) {
		return "", errors.New("native input part ordering metadata is unsupported")
	}
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	var head uint64
	normal := floor == "prt_"
	if len(floor) == 30 && strings.HasPrefix(floor, "prt_") {
		parsed, err := strconv.ParseUint(floor[4:16], 16, 48)
		normal = err == nil && parsed < 0xffffffffffff && strings.Trim(floor[4:16], "0123456789abcdef") == "" && strings.Trim(floor[16:], alphabet) == ""
		head = parsed + 1
	}
	if normal {
		b := make([]byte, 14)
		if _, err := io.ReadFull(entropy, b); err != nil {
			return "", err
		}
		for i := range b {
			b[i] = alphabet[int(b[i])%len(alphabet)]
		}
		return fmt.Sprintf("prt_%012x%s", head, b), nil
	}
	b := make([]byte, 16)
	if _, err := io.ReadFull(entropy, b); err != nil {
		return "", err
	}
	for i := min(len(floor)-1, 223); i >= 4; i-- {
		if floor[i] < 126 {
			return floor[:i] + string([]byte{floor[i] + 1}) + hex.EncodeToString(b), nil
		}
	}
	if len(floor)+32 <= 256 {
		return floor + hex.EncodeToString(b), nil
	}
	return "", errors.New("no acceptable part ID successor within the adapter ordering bound")
}

// PrivateRequest is an opt-in on the existing resident connection. Broad public
// tool ancestry is not inbox ownership: only the current root phase can bind.
func (o *laneToolOwner) PrivateRequest(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, bool, error) {
	if method != "sessionbus/native-input" {
		return nil, false, nil
	}
	var operation struct {
		Operation string `json:"operation"`
	}
	if json.Unmarshal(params, &operation) != nil {
		return nil, true, errors.New("invalid native input request")
	}
	if operation.Operation != "bind" && operation.Operation != "step" {
		return nil, false, nil
	}
	var request nativeInputRequest
	decoder := json.NewDecoder(bytes.NewReader(params))
	decoder.DisallowUnknownFields()
	var fields map[string]json.RawMessage
	if decoder.Decode(&request) != nil || json.Unmarshal(params, &fields) != nil || len(fields) != map[string]int{"bind": 4, "step": 6}[request.Operation] || string(fields["created"]) == "null" || request.Created < 0 || !validNativeID(request.SessionID) || !validMessageID(request.MessageID) || len(request.MessageID) > 256 || (request.Operation == "step" && (request.Token == "" || len(request.Token) > 512 || !validPartFloor(request.After))) {
		return nil, true, errors.New("invalid native input binding")
	}
	value, err := o.endpoint.owner.nativeInput(ctx, request)
	return value, true, err
}

func (p *Wrapper) nativeInput(ctx context.Context, request nativeInputRequest) (json.RawMessage, error) {
	empty := json.RawMessage(`{"parts":[]}`)
	if request.Operation == "bind" {
		empty = json.RawMessage(`{"token":null}`)
	}
	p.mu.Lock()
	t := p.active
	if t == nil || !t.admission || t.stopping || p.closing || !p.opened || p.ctx.Err() != nil || t.run.Interrupted() || ctx.Err() != nil || request.SessionID != p.id {
		p.mu.Unlock()
		return empty, ctx.Err()
	}
	phase := t.phase
	if phase.sealed || phase.original == nil {
		p.mu.Unlock()
		return empty, nil
	}
	if request.Operation == "bind" {
		if request.MessageID != phase.initial {
			p.mu.Unlock()
			return empty, nil
		}
		if phase.bound != nil && (request.MessageID != phase.bound.MessageID || request.Created != phase.bound.Created) {
			p.mu.Unlock()
			return empty, nil
		}
		phase.bound = &request
		p.mu.Unlock()
		value, err := json.Marshal(map[string]string{"token": phase.initial})
		return value, err
	}
	if phase.bound == nil || request.Token != phase.initial || !request.atOrAfter(*phase.bound) || phase.claim {
		p.mu.Unlock()
		return empty, nil
	}
	if !validPartFloor(request.After) {
		p.mu.Unlock()
		return nil, errors.New("native input part ordering metadata is unsupported")
	}
	if phase.partParent != request.MessageID {
		phase.partID, phase.partParent = "", request.MessageID
	}
	phase.stepSeen = true
	if len(t.queue) == 0 {
		p.mu.Unlock()
		return empty, nil
	}
	// Claim/prepare/begin are serialized with sealing and the final empty check.
	// Successful begin, not a native response, transfers ownership of the prefix.
	partID, err := orderedPartID(max(request.After, phase.partID), rand.Reader)
	if err != nil || !validPartFloor(partID) || partID <= max(request.After, phase.partID) {
		p.mu.Unlock()
		return nil, errors.Join(err, errors.New("native input part ID did not advance"))
	}
	phase.claim = true
	phase.hooks.Add(1)
	defer phase.hooks.Done()
	defer func() { p.mu.Lock(); phase.claim = false; p.mu.Unlock() }()
	part := nativeTextPart{ID: partID, SessionID: p.id, MessageID: request.MessageID, Type: "text"}
	count := 0
	for _, item := range t.queue {
		candidate := part
		if candidate.Text != "" {
			candidate.Text += "\n\n"
		}
		candidate.Text += item.text
		body, marshalErr := json.Marshal(map[string]any{"parts": []nativeTextPart{candidate}})
		if marshalErr != nil || len(body) > maxNativeRequest {
			break
		}
		part, count = candidate, count+1
	}
	if count == 0 {
		p.mu.Unlock()
		return nil, errors.New("native input part exceeds returned-data limit")
	}
	combined, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(phase.ctx, cancel)
	defer stop()
	defer cancel()
	body, err := encodeNativeFor(p.kind, part)
	if err != nil {
		p.mu.Unlock()
		return nil, err
	}
	prepared, err := p.client.prepare(combined, http.MethodPatch, sessionPath(p.id)+"/message/"+url.PathEscape(part.MessageID)+"/part/"+url.PathEscape(part.ID), body)
	if err != nil {
		p.mu.Unlock()
		return nil, err
	}
	op, err := p.client.begin(prepared, 200)
	if err != nil {
		p.mu.Unlock()
		return nil, err
	}
	phase.partID = part.ID
	for _, item := range t.queue[:count] {
		t.bytes -= len(item.text)
		item.text = ""
	}
	t.queue = append([]*laneInput(nil), t.queue[count:]...)
	p.mu.Unlock()
	raw, err := op.wait()
	if err != nil {
		return nil, err
	}
	var confirmed nativeTextPart
	if json.Unmarshal(raw, &confirmed) != nil || confirmed != part {
		return nil, errors.New("native input part response was not confirmed")
	}
	return json.Marshal(map[string]any{"parts": []nativeTextPart{confirmed}})
}

// successor closes admission and checks empty in the same critical section as
// Deliver. Never-handed-off input that crossed the last step stays in this Run.
func (p *Wrapper) successor(ctx context.Context, t *laneRun, result kit.TurnResult) (*lanePhase, error) {
	p.mu.Lock()
	if result.Outcome != "completed" || t.stopping || t.run.Interrupted() || p.closing || p.ctx.Err() != nil || ctx.Err() != nil || len(t.queue) == 0 {
		t.admission = false
		p.mu.Unlock()
		return nil, nil
	}
	id, err := p.nextMessageID()
	if err != nil {
		p.mu.Unlock()
		return nil, err
	}
	phaseCtx, cancel := context.WithCancel(p.ctx)
	phase := &lanePhase{initial: id, ctx: phaseCtx, cancel: cancel, started: make(chan struct{})}
	previous := t.phase
	t.phase = phase
	// Reserve an oldest prefix; it stays owned until begin succeeds. Later
	// Deliver calls may append, but cannot alter this exact successor's input.
	text, count := "", 0
	for _, item := range t.queue {
		candidate := text
		if candidate != "" {
			candidate += "\n\n"
		}
		candidate += item.text
		if _, encodeErr := encodeNativeFor(p.kind, p.promptBody(id, candidate)); encodeErr != nil {
			break
		}
		text, count = candidate, count+1
	}
	p.mu.Unlock()
	if count == 0 {
		cancel()
		return nil, p.kind.err("successor input exceeds native request limit")
	}
	defer func() {
		if phase.original == nil {
			cancel()
		}
	}()
	for {
		p.mu.Lock()
		epoch, changed := p.blockerEpoch, t.changed
		if p.active != t || t.stopping || !t.admission || t.run.Interrupted() || p.closing || ctx.Err() != nil || p.ctx.Err() != nil {
			p.mu.Unlock()
			return nil, nil
		}
		p.mu.Unlock()
		if p.kind == kiloNative {
			blocked, checkErr := p.blockers(ctx)
			if checkErr != nil {
				return nil, checkErr
			}
			if blocked {
				// No polling: only native blocker events or lifetime end wake this
				// bounded never-attempted input. Cancel cannot start later work.
				select {
				case <-changed:
					continue
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-p.ctx.Done():
					return nil, context.Cause(p.ctx)
				}
			}
		}
		body, encodeErr := encodeNativeFor(p.kind, p.promptBody(id, text))
		if encodeErr != nil {
			return nil, encodeErr
		}
		prepared, prepareErr := p.client.prepare(p.ctx, http.MethodPost, sessionPath(p.id)+"/message", body)
		if prepareErr != nil {
			return nil, prepareErr
		}
		p.mu.Lock()
		if p.active != t || t.phase != phase || t.stopping || !t.admission || t.run.Interrupted() || p.closing || ctx.Err() != nil || p.ctx.Err() != nil {
			p.mu.Unlock()
			return nil, nil
		}
		if p.kind == kiloNative && epoch != p.blockerEpoch {
			p.mu.Unlock()
			continue
		}
		// These are pre-invocation checks, not a native lease. An external
		// same-root command can create a question after the final check and
		// ordinary Kilo POST can dismiss it, as in the released idle fallback.
		op, beginErr := p.client.begin(prepared, 200)
		if beginErr != nil {
			p.mu.Unlock()
			return nil, beginErr
		}
		phase.original = op
		for _, item := range t.queue[:count] {
			t.bytes -= len(item.text)
			item.text = ""
		}
		t.queue = append([]*laneInput(nil), t.queue[count:]...)
		// The new binding cannot inherit the completed prior operation/token.
		previous.bound = nil
		p.mu.Unlock()
		return phase, nil
	}
}

func (p *Wrapper) blockers(ctx context.Context) (bool, error) {
	for _, kind := range []string{"permission", "question"} {
		raw, err := p.client.call(ctx, http.MethodGet, "/"+kind, nil, 200)
		if err != nil {
			return false, err
		}
		var pending []struct {
			SessionID string `json:"sessionID"`
		}
		if json.Unmarshal(raw, &pending) != nil || pending == nil {
			return false, p.kind.err("pending blocker snapshot malformed")
		}
		for _, request := range pending {
			if !validNativeID(request.SessionID) {
				return false, p.kind.err("pending blocker identity malformed")
			}
			if request.SessionID == p.id {
				return true, nil
			}
		}
	}
	return false, nil
}

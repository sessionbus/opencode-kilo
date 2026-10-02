// SPDX-License-Identifier: MIT

package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strings"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/sessionbus/peer-common/host"
)

const (
	promptInflight = iota
	promptAdmitted
)

// laneRun is one Worker Run: the native inputs it owns and what the ordered
// native event stream has shown about them.
type laneRun struct {
	run       *kit.Run
	own       string
	prompts   map[string]int // inputs of this Run whose admission is known or pending
	released  map[string]bool
	delivered map[string]int // event position of each input's native delivery
	terminal  int            // position of the latest succeeded terminal after our delivery
	admitted  bool           // native announced our own prompt's admission in the stream
	rejected  bool           // this lane declined a native ask during this Run
	cancelled bool           // interrupted: no further input; undelivered steers withdrawn at the end
	final     bool
	early     bool // the terminal came before native delivered our own prompt
	outcome   string
	reason    string
	message   string
	settled   chan struct{}
}

func newLaneRun(run *kit.Run, own string) *laneRun {
	return &laneRun{run: run, own: own, prompts: map[string]int{own: promptInflight}, released: map[string]bool{}, delivered: map[string]int{}, settled: make(chan struct{})}
}

// undelivered lists the steers of this Run native has not delivered: every
// tracked or released input except the Run's own prompt, which is left to
// native. The caller holds the lane lock.
func (r *laneRun) undelivered() []string {
	var ids []string
	for id := range r.prompts {
		if _, delivered := r.delivered[id]; !delivered && id != r.own {
			ids = append(ids, id)
		}
	}
	for id := range r.released {
		if id != r.own {
			ids = append(ids, id)
		}
	}
	return ids
}

// userInterrupted reports a Run whose own native terminal is a user
// interrupt. Native leaves its undelivered steers parked (resume=false), so
// they are withdrawn: those pending at the end, and any answered after it.
func (r *laneRun) userInterrupted() bool {
	return r.final && r.outcome == "interrupted" && r.reason == "user"
}

// settle records the Run's terminal once.
func (r *laneRun) settle(outcome, reason, message string) {
	if r.final {
		return
	}
	_, delivered := r.delivered[r.own]
	r.final, r.early, r.outcome, r.reason, r.message = true, !delivered, outcome, reason, message
	close(r.settled)
}

// evaluate completes the Run at a succeeded terminal that follows the native
// delivery of every input this Run still tracks. A request in flight stays
// tracked until native delivers it or its answer releases it.
func (r *laneRun) evaluate() {
	if r.final || r.terminal == 0 {
		return
	}
	for id := range r.prompts {
		if at, ok := r.delivered[id]; !ok || at > r.terminal {
			return
		}
	}
	r.settle("succeeded", "", "")
}

// resolve applies one prompt request's HTTP outcome. Positive native evidence
// of admission is kept whatever the HTTP outcome; a request whose admission
// stays unknown is released from this Run's wait without asserting either
// way. It reports whether native admitted the input.
func (l *Lane) resolve(r *laneRun, id string, err error) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	state, tracked := r.prompts[id]
	admitted := err == nil || (tracked && state == promptAdmitted)
	if _, delivered := r.delivered[id]; delivered {
		admitted = true
	}
	switch {
	case admitted:
		r.prompts[id] = promptAdmitted
	case tracked:
		delete(r.prompts, id)
		var refused *nativeStatus
		if !errors.As(err, &refused) || !refused.refused() {
			r.released[id] = true
		}
	}
	r.evaluate()
	return admitted
}

// observe applies one native event in stream order. It never blocks: native
// drops a slow reader.
func (l *Lane) observe(event nativeEvent) {
	if event.Type == "server.connected" {
		select {
		case <-l.connected:
		default:
			close(l.connected)
		}
		return
	}
	var data struct {
		SessionID string          `json:"sessionID"`
		InboxID   string          `json:"inboxID"`
		Reason    string          `json:"reason"`
		ID        string          `json:"id"`
		Error     json.RawMessage `json:"error"`
		Form      *struct {
			ID        string `json:"id"`
			SessionID string `json:"sessionID"`
			Metadata  struct {
				Kind string `json:"kind"`
			} `json:"metadata"`
		} `json:"form"`
	}
	_ = json.Unmarshal(event.Data, &data)
	l.mu.Lock()
	l.position++
	at, r, session := l.position, l.active, l.session
	if r != nil && data.SessionID == session && session != "" {
		switch event.Type {
		case "session.inbox.enqueued":
			if data.InboxID == r.own {
				r.admitted = true
			}
			if _, ok := r.prompts[data.InboxID]; ok {
				r.prompts[data.InboxID] = promptAdmitted
			} else if r.released[data.InboxID] && !r.final {
				delete(r.released, data.InboxID)
				r.prompts[data.InboxID] = promptAdmitted
			}
		case "session.inbox.delivered":
			if _, ok := r.prompts[data.InboxID]; ok {
				r.prompts[data.InboxID] = promptAdmitted
				r.delivered[data.InboxID] = at
			}
		case "session.execution.succeeded":
			if _, ours := r.delivered[r.own]; ours {
				r.terminal = at
				r.evaluate()
			}
		// A failed or interrupted terminal after our prompt's admission ends the
		// busy period our prompt joined, even before native delivered it (native
		// can fail while preparing the step that would promote it); before our
		// delivery it may also be earlier work's, so Run reports it as unknown.
		// A terminal before our admission belongs to earlier work.
		case "session.execution.failed":
			if r.admitted {
				var failure struct {
					Type    string `json:"type"`
					Message string `json:"message"`
				}
				_ = json.Unmarshal(data.Error, &failure)
				r.settle("failed", failure.Type, failure.Message)
			}
		case "session.execution.interrupted":
			if r.admitted {
				message := ""
				if r.rejected && data.Reason == "shutdown" {
					message = "run ended by permission rejection"
				}
				r.settle("interrupted", data.Reason, message)
			}
		}
	}
	var work *declineWork
	switch {
	case event.Type == "permission.asked" && data.ID != "":
		work = &declineWork{session: data.SessionID, method: "POST", path: "/permission/" + url.PathEscape(data.ID) + "/reply", body: map[string]string{"decision": "reject", "message": declined}, run: r, settled: []string{"PermissionNotFoundError"}}
	case event.Type == "form.created" && data.Form != nil && data.Form.ID != "":
		// As native's headless runner: every form is cancelled; only a question
		// gets the message that lets the model continue without an answer.
		path := "/form/" + url.PathEscape(data.Form.ID)
		if data.Form.Metadata.Kind == "question" {
			path += "?message=" + url.QueryEscape(declined)
		}
		work = &declineWork{session: data.Form.SessionID, method: "DELETE", path: path, settled: []string{"FormNotFoundError", "FormAlreadySettledError"}}
	}
	l.mu.Unlock()
	if work != nil {
		l.decline(*work)
	}
}

// declineWork is one native ask or form to answer, with the Run that was
// active when native raised it and the native answers that mean it is no
// longer pending.
type declineWork struct {
	session, method, path string
	body                  any
	run                   *laneRun
	settled               []string
}

// decline answers a native ask or form of the lane's sessions in stream
// order, inline in the event reader as native's own headless runner does; no
// human is in a lane. Asks of other sessions on the same server are left
// alone, and an ask another client already settled is skipped.
func (l *Lane) decline(work declineWork) {
	l.mu.Lock()
	life, client := l.ctx, l.client
	l.mu.Unlock()
	if life == nil || client == nil {
		return
	}
	belongs, err := l.belongs(life, work.session)
	if err != nil || !belongs {
		return
	}
	err = client.call(life, work.method, "/api/session/"+url.PathEscape(work.session)+work.path, work.body, nil)
	var answered *nativeStatus
	switch {
	case err == nil:
		// The explanatory label belongs to the Run native raised the ask in.
		if work.run != nil && work.method == "POST" {
			l.mu.Lock()
			if !work.run.final {
				work.run.rejected = true
			}
			l.mu.Unlock()
		}
	case errors.As(err, &answered) && slices.Contains(work.settled, answered.tag):
	case life.Err() == nil:
		l.fail(err)
	}
}

// Run submits one input as a native prompt and reports the native terminal of
// the busy period that contains every input this Run admitted.
func (l *Lane) Run(ctx context.Context, run *kit.Run, input kit.RunInput) (kit.TurnResult, error) {
	var text string
	var err error
	switch {
	case input.Delivery != nil:
		text, err = host.RenderNativeMessage(*input.Delivery)
	case input.Text != nil:
		text = *input.Text
	default:
		err = errors.New("missing Run input")
	}
	if err != nil {
		return kit.TurnResult{}, err
	}
	if strings.TrimSpace(text) == "" || len(text) > maxNativeInput {
		return kit.TurnResult{}, errors.New("OpenCode Run input is empty or too large")
	}
	id, err := l.ids.next()
	if err != nil {
		return kit.TurnResult{}, err
	}
	l.mu.Lock()
	if !l.opened || l.closing || l.ctx.Err() != nil || l.active != nil {
		l.mu.Unlock()
		return kit.TurnResult{}, errors.New("OpenCode lane unavailable or busy")
	}
	r := newLaneRun(run, id)
	l.active = r
	client, path, life, session, tools := l.client, l.promptPath(), l.ctx, l.session, l.tools
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		if l.active == r {
			l.active = nil
		}
		l.mu.Unlock()
	}()
	stop := context.AfterFunc(ctx, func() { l.fail(ctx.Err()) })
	defer stop()
	if err := l.host.bind(life, client, session, tools); err != nil {
		return kit.TurnResult{}, err
	}
	err = client.call(life, "POST", path, map[string]string{"id": id, "text": text}, nil)
	if !l.resolve(r, id, err) {
		return kit.TurnResult{}, errors.Join(errors.New("OpenCode did not admit the Run input"), err)
	}
	run.Admitted()
	if input.Delivery != nil {
		if err := run.ReportDelivery(kit.DeliveryReceipt{Disposition: "written"}, nil); err != nil {
			l.fail(err)
		}
	}
	// An interrupt that arrived before this Run was active found nothing to
	// stop. A failed request is reported as the kit reports its own call; it
	// leaves the task running and the lane usable.
	if run.Interrupted() {
		if err := l.Interrupt(life, run); err != nil {
			fmt.Fprintf(os.Stderr, "sessionbus: product interrupt: %q\n", err.Error())
		}
	}
	select {
	case <-r.settled:
	case <-life.Done():
		return kit.TurnResult{}, context.Cause(life)
	}
	l.mu.Lock()
	outcome, reason, message, unknown, early := r.outcome, r.reason, r.message, len(r.released), r.early
	var steers []string
	if r.userInterrupted() {
		steers = r.undelivered()
	}
	l.mu.Unlock()
	// A user-interrupted Run withdraws its undelivered steers before it ends:
	// native leaves them parked, and the next Run's prompt would deliver them.
	// No retry; a failure is reported with the Run's terminal.
	var failed []error
	for _, steer := range steers {
		failed = append(failed, l.withdraw(client, session, steer))
	}
	if errors.Join(failed...) != nil {
		if message != "" {
			message += "; "
		}
		message += "pending input was not withdrawn and may run with the next task"
	}
	if early && outcome != "succeeded" {
		return kit.TurnResult{}, fmt.Errorf("OpenCode execution %s (%s: %s) before delivering this Run's input; the input stays pending in native", outcome, reason, message)
	}
	switch outcome {
	case "failed":
		return kit.TurnResult{Outcome: "failed", Result: message, NativeStopReason: reason}, nil
	case "interrupted":
		return kit.TurnResult{Outcome: "interrupted", Result: message, NativeStopReason: reason}, nil
	}
	// A delivery whose native admission stayed unknown may still run: a
	// completed result would claim more than native showed.
	if unknown > 0 {
		return kit.TurnResult{}, fmt.Errorf("OpenCode admission of %d delivery(ies) in this Run is unknown", unknown)
	}
	return l.project(life, client, session, id)
}

type nativeMessage struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Finish  string `json:"finish"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

// project reads the native result after our prompt: the newest assistant
// message that follows our prompt ID. Our prompt must be found.
func (l *Lane) project(ctx context.Context, client *nativeClient, session, own string) (kit.TurnResult, error) {
	var latest *nativeMessage
	cursor := ""
	for page := 0; page < 64; page++ {
		path := "/api/session/" + url.PathEscape(session) + "/message?limit=200&order=desc"
		if cursor != "" {
			path = "/api/session/" + url.PathEscape(session) + "/message?limit=200&cursor=" + url.QueryEscape(cursor)
		}
		var listed struct {
			Data   []nativeMessage `json:"data"`
			Cursor struct {
				Next *string `json:"next"`
			} `json:"cursor"`
		}
		if err := client.call(ctx, "GET", path, nil, &listed); err != nil {
			return kit.TurnResult{}, err
		}
		for index := range listed.Data {
			message := &listed.Data[index]
			if message.ID == own {
				if latest == nil {
					return kit.TurnResult{}, errors.New("OpenCode Run has no assistant message after its prompt")
				}
				parts := make([]string, 0, len(latest.Content))
				for _, part := range latest.Content {
					if part.Type == "text" && part.Text != "" {
						parts = append(parts, part.Text)
					}
				}
				return kit.TurnResult{Outcome: "completed", Result: strings.Join(parts, "\n"), NativeStopReason: latest.Finish}, nil
			}
			if latest == nil && message.Type == "assistant" {
				latest = message
			}
		}
		if listed.Cursor.Next == nil || *listed.Cursor.Next == "" {
			break
		}
		cursor = *listed.Cursor.Next
	}
	return kit.TurnResult{}, errors.New("OpenCode Run prompt not found in session history")
}

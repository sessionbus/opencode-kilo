// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/sessionbus/peer-common/host"
)

// laneInputTool is the lane plugin's hidden hook tool, never model-advertised.
// Native has no route into a running loop (a busy prompt supersedes the task),
// so a lane steers the way interactive does: before each model call the
// plugin's transform hook asks the owner for queued input, the owner writes it
// as one native text part of the user message that call answers, and the
// plugin adds that part to the call. The pinned hook tool returns no data, so
// the plugin reads the written part back from native.
const laneInputTool = "sessionbus_native_input"

var errNoLaneInput = errors.New("no queued input")
var nativePartID = regexp.MustCompile(`^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$`)

// queue accepts input for the active Run's native loop: the next model call's
// hook takes it, or the Run sends it as one more message before it ends.
// After the Run's final check it refuses; the daemon then keeps the delivery
// for the next Run, as before.
func (p *Wrapper) queue(run *kit.Run, text string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	t := p.active
	if t == nil || t.run != run || t.closed || len(t.inbox) >= host.MaxQueuedDeliveries || t.inboxBytes+len(text) > host.MaxQueuedBytes {
		return false
	}
	t.inbox = append(t.inbox, text)
	t.inboxBytes += len(text)
	return true
}

// takeInbox removes the Run's queued input once its native write is accepted;
// the caller holds p.mu.
func takeInbox(t *laneRun) string {
	text := strings.Join(t.inbox, "\n\n")
	t.inbox, t.inboxBytes = nil, 0
	return text
}

// LaneInput answers the hidden hook tool: it writes the active Run's queued
// input as the requested native part and completes once the write settles.
// As in the interactive owner, input leaves the FIFO only when the write is
// accepted: a refused write keeps it for the next pull or the Run's last
// message, and an accepted write is attempted once and never replayed.
func (p *Wrapper) LaneInput(raw json.RawMessage) (<-chan error, error) {
	var in struct {
		SessionID string `json:"session_id"`
		MessageID string `json:"message_id"`
		PartID    string `json:"part_id"`
	}
	if json.Unmarshal(raw, &in) != nil || !validMessageID(in.MessageID) || !nativePartID.MatchString(in.PartID) {
		return nil, errors.New("invalid native input request")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	t := p.active
	if in.SessionID != p.id || t == nil || t.closed || len(t.inbox) == 0 || p.client == nil {
		return nil, errNoLaneInput
	}
	part := map[string]string{"id": in.PartID, "sessionID": in.SessionID, "messageID": in.MessageID, "type": "text", "text": strings.Join(t.inbox, "\n\n")}
	b, err := encodeNativeFor(p.kind, part)
	if err != nil {
		return nil, err
	}
	request, err := p.client.prepare(p.ctx, http.MethodPatch, sessionPath(in.SessionID)+"/message/"+url.PathEscape(in.MessageID)+"/part/"+url.PathEscape(in.PartID), b)
	if err != nil {
		return nil, err
	}
	op, err := p.client.begin(request, 200)
	if err != nil {
		return nil, err
	}
	takeInbox(t)
	done := make(chan error, 1)
	p.workers.Add(1)
	go func() {
		defer p.workers.Done()
		_, err := op.wait()
		done <- err
	}()
	return done, nil
}

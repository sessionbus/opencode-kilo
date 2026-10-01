// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/sessionbus/peer-common/host"
)

// A Deliver during the active Run's loop is taken for that task (injected);
// the hook writes it once as the requested native part; after the Run's
// final check a Deliver refuses so the daemon keeps it for the next Run.
func TestLaneBusyInputIsWrittenAsTheRequestedPartOnce(t *testing.T) {
	var mu sync.Mutex
	var patches []string
	native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		patches = append(patches, r.Method+" "+r.URL.Path+" "+string(b))
		mu.Unlock()
		w.Write([]byte(`{}`))
	}))
	defer native.Close()
	life, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	run := &kit.Run{}
	p := &Wrapper{ctx: life, cancel: cancel, id: "ses_lane", client: newLaneHTTP(native.URL, "/work", "sessionbus", "secret")}
	t.Cleanup(p.workers.Wait)
	p.active = &laneRun{run: run}
	deliver := func(body string) (kit.DeliveryReceipt, error) {
		return p.Deliver(context.Background(), kit.DeliveryRequest{MessageID: "m-" + body, From: kit.DeliverySource{SessionID: "sender@local", Product: "claude", Groups: []string{}}, Body: body}, run)
	}
	request := json.RawMessage(`{"session_id":"ses_lane","message_id":"msg_user","part_id":"prt_000000000002ABCDEFGHIJKLMN"}`)

	if _, err := p.LaneInput(request); !errors.Is(err, errNoLaneInput) {
		t.Fatalf("empty FIFO: %v", err)
	}
	for _, body := range []string{"STEER-ONE", "STEER-TWO"} {
		if receipt, err := deliver(body); err != nil || receipt.Disposition != "injected" {
			t.Fatalf("deliver %s = %#v %v", body, receipt, err)
		}
	}
	done, err := p.LaneInput(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if len(patches) != 1 || !strings.HasPrefix(patches[0], "PATCH /session/ses_lane/message/msg_user/part/prt_000000000002ABCDEFGHIJKLMN ") || !strings.Contains(patches[0], "STEER-ONE") || !strings.Contains(patches[0], "STEER-TWO") {
		t.Fatalf("patches = %q", patches)
	}
	mu.Unlock()
	// Taken input is never written again.
	if _, err := p.LaneInput(request); !errors.Is(err, errNoLaneInput) {
		t.Fatalf("second take: %v", err)
	}
	if _, err := p.LaneInput(json.RawMessage(`{"session_id":"ses_other","message_id":"msg_user","part_id":"prt_000000000003ABCDEFGHIJKLMN"}`)); !errors.Is(err, errNoLaneInput) {
		t.Fatalf("other session: %v", err)
	}
	p.mu.Lock()
	p.active.closed = true
	p.mu.Unlock()
	if _, err := deliver("LATE"); err == nil || !strings.Contains(err.Error(), host.NotRunning().Error()) {
		t.Fatalf("after the final check: %v", err)
	}
}

// A write the HTTP client refuses before submission keeps the input queued
// for the next pull, as the interactive owner keeps never-attempted input.
func TestLaneBusyInputRefusedBeforeSubmissionStaysQueued(t *testing.T) {
	life, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	run := &kit.Run{}
	client := newLaneHTTP("http://127.0.0.1:1", "/work", "sessionbus", "secret")
	p := &Wrapper{ctx: life, cancel: cancel, id: "ses_lane", client: client}
	t.Cleanup(p.workers.Wait)
	p.active = &laneRun{run: run}
	if !p.queue(run, "KEEP") {
		t.Fatal("queue refused")
	}
	// Exhaust the client's work slots: begin refuses without submitting.
	for len(client.slots) < cap(client.slots) {
		client.slots <- struct{}{}
	}
	request := json.RawMessage(`{"session_id":"ses_lane","message_id":"msg_user","part_id":"prt_000000000002ABCDEFGHIJKLMN"}`)
	if _, err := p.LaneInput(request); err == nil || errors.Is(err, errNoLaneInput) {
		t.Fatalf("refused write: %v", err)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.active.inbox) != 1 || p.active.inbox[0] != "KEEP" {
		t.Fatalf("inbox = %q", p.active.inbox)
	}
}

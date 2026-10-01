// SPDX-License-Identifier: MIT

package opencode

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/antst/sessionbus/bus/sdk/go/protocol"
	"github.com/sessionbus/peer-common/host"
	"github.com/sessionbus/peer-common/testsocket"
)

// fakeNative serves the parts of the OpenCode v2 API a lane uses. Tests emit
// native events in order and may hold or break individual prompt responses.
type fakeNative struct {
	srv      *httptest.Server
	events   chan string
	mu       sync.Mutex
	sessions map[string]nativeSession
	created  []map[string]any
	patched  []map[string]any
	prompts  []map[string]string
	replies  []string
	history  []map[string]any
	holds    map[string]func(http.ResponseWriter) // by prompt text
	notify   chan map[string]string
	drop     chan struct{}
	slowGet  time.Duration
	settled  map[string]bool // ask or form IDs another client already answered
	withdraw int             // status for inbox withdrawals; zero answers 204
	halt     func() int      // runs before the interrupt answer; nonzero is its status
}

func newFakeNative(t *testing.T) *fakeNative {
	f := &fakeNative{events: make(chan string, 64), sessions: map[string]nativeSession{}, holds: map[string]func(http.ResponseWriter){}, notify: make(chan map[string]string, 16), drop: make(chan struct{}), settled: map[string]bool{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeNative) emit(kind string, data map[string]any) {
	b, _ := json.Marshal(map[string]any{"type": kind, "data": data})
	f.events <- string(b)
}

func (f *fakeNative) serve(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("authorization") != "Basic test" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	path := r.URL.Path
	parts := strings.Split(strings.TrimPrefix(path, "/api/session/"), "/")
	switch {
	case path == "/api/event":
		flusher := w.(http.Flusher)
		fmt.Fprint(w, "data: {\"type\":\"server.connected\",\"data\":{}}\n\n")
		flusher.Flush()
		for {
			select {
			case line := <-f.events:
				fmt.Fprintf(w, "data: %s\n\n", line)
				flusher.Flush()
			case <-r.Context().Done():
				return
			case <-f.drop:
				return
			}
		}
	case path == "/api/session" && r.Method == "POST":
		f.mu.Lock()
		f.created = append(f.created, body)
		f.sessions["ses_lane"] = nativeSession{ID: "ses_lane"}
		f.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": "ses_lane"}})
	case len(parts) == 1 && r.Method == "GET":
		f.mu.Lock()
		s, ok := f.sessions[parts[0]]
		slow := f.slowGet
		f.mu.Unlock()
		if parts[0] != "ses_lane" {
			time.Sleep(slow)
		}
		if !ok {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"data": s})
	case len(parts) == 1 && r.Method == "PATCH":
		f.mu.Lock()
		f.patched = append(f.patched, body)
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	case len(parts) == 2 && parts[1] == "prompt":
		prompt := map[string]string{"session": parts[0]}
		for k, v := range body {
			prompt[k], _ = v.(string)
		}
		f.mu.Lock()
		f.prompts = append(f.prompts, prompt)
		var hold func(http.ResponseWriter)
		for key, h := range f.holds {
			if strings.Contains(prompt["text"], key) {
				hold = h
			}
		}
		f.mu.Unlock()
		f.notify <- prompt
		if hold != nil {
			hold(w)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": prompt["id"]}})
	case len(parts) == 2 && parts[1] == "interrupt":
		f.mu.Lock()
		f.replies = append(f.replies, "interrupt "+r.URL.RawQuery)
		halt := f.halt
		f.mu.Unlock()
		if halt != nil {
			if status := halt(); status != 0 {
				w.WriteHeader(status)
				return
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"interrupted": true})
	case len(parts) == 3 && parts[1] == "inbox" && r.Method == "DELETE":
		f.mu.Lock()
		f.replies = append(f.replies, "withdraw "+parts[2])
		status := f.withdraw
		f.mu.Unlock()
		if status == 0 {
			status = http.StatusNoContent
		}
		w.WriteHeader(status)
	case len(parts) == 2 && parts[1] == "message":
		f.mu.Lock()
		history := f.history
		f.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"data": history, "cursor": map[string]any{"next": nil}})
	case len(parts) == 4 && parts[1] == "permission" || len(parts) == 3 && parts[1] == "form":
		b, _ := json.Marshal(body)
		f.mu.Lock()
		f.replies = append(f.replies, r.Method+" "+path+"?"+r.URL.RawQuery+" "+string(b))
		settled := f.settled[parts[2]]
		f.mu.Unlock()
		if settled {
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]string{"_tag": "PermissionNotFoundError"})
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// breakResponse drops the connection without an HTTP answer.
func breakResponse(w http.ResponseWriter) {
	connection, _, err := w.(http.Hijacker).Hijack()
	if err == nil {
		connection.Close()
	}
}

type fakeHost struct {
	client  *nativeClient
	mu      sync.Mutex
	bindErr error
	binds   int
}

func (h *fakeHost) start(context.Context, string, string) (*nativeClient, error) {
	return h.client, nil
}
func (h *fakeHost) bind(context.Context, *nativeClient, string, string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.binds++
	return h.bindErr
}
func (h *fakeHost) close() error { return nil }

type laneFixture struct {
	native  *fakeNative
	host    *fakeHost
	lane    *Lane
	c       net.Conn
	mu      sync.Mutex
	next    int64
	pending map[int64]chan protocol.Frame
	closes  chan protocol.Frame
	ctx     context.Context
}

func newLaneFixture(t *testing.T, open kit.OpenOptions, resume string, setup func(*fakeNative)) *laneFixture {
	t.Helper()
	f := newUnopenedLaneFixture(t, setup)
	var opened kit.OpenResult
	if frame := f.open(t, open, resume); frame.Error != nil {
		t.Fatalf("open: %+v", frame.Error)
	} else if json.Unmarshal(frame.Result, &opened) != nil || opened.SessionID != "ses_lane" {
		t.Fatalf("open result %s", frame.Result)
	}
	return f
}

func (f *laneFixture) open(t *testing.T, open kit.OpenOptions, resume string) protocol.Frame {
	t.Helper()
	open.Cwd = t.TempDir()
	return f.answer(t, f.begin(t, "session.open", kit.OpenRequest{Name: "lane@local", Groups: []string{}, ResumeSessionID: resume, Open: open}))
}

func newUnopenedLaneFixture(t *testing.T, setup func(*fakeNative)) *laneFixture {
	t.Helper()
	native := newFakeNative(t)
	if setup != nil {
		setup(native)
	}
	h := &fakeHost{client: &nativeClient{base: native.srv.URL, auth: "Basic test", http: &http.Client{Timeout: 10 * time.Second}}}
	socket := filepath.Join(testsocket.Directory(t), "bus.sock")
	l, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(host.SocketEnv, socket)
	t.Setenv(host.TokenEnv, "token")
	lane := newLane(socket, h)
	worker := kit.NewWorker(lane)
	lane.SetCaller(worker.Caller())
	lane.SetShutdown(worker.Shutdown)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	served := make(chan error, 1)
	go func() { served <- worker.Serve(ctx) }()
	c, err := l.Accept()
	if err != nil {
		t.Fatal(err)
	}
	f := &laneFixture{native: native, host: h, lane: lane, c: c, pending: map[int64]chan protocol.Frame{}, closes: make(chan protocol.Frame, 4), ctx: ctx}
	hello, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		reader := bufio.NewReader(c)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			frame, err := protocol.DecodeFrame(line[:len(line)-1])
			if err != nil {
				panic(err)
			}
			f.mu.Lock()
			switch {
			case frame.Method == "session.close":
				f.closes <- frame
			case frame.Method != "":
				b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": frame.ID, "result": map[string]any{}})
				_, _ = c.Write(append(b, '\n'))
				if frame.Method == "session.hello" {
					close(hello)
				}
			default:
				if ch := f.pending[frame.ID]; ch != nil {
					delete(f.pending, frame.ID)
					ch <- frame
				}
			}
			f.mu.Unlock()
		}
	}()
	t.Cleanup(func() { cancel(); c.Close(); <-served; <-done; l.Close() })
	select {
	case <-hello:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	return f
}

func (f *laneFixture) begin(t *testing.T, method string, params any) chan protocol.Frame {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next++
	response := make(chan protocol.Frame, 1)
	f.pending[f.next] = response
	b, err := protocol.RequestBytes(f.next, method, params)
	if err == nil {
		_, err = f.c.Write(b)
	}
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func (f *laneFixture) answer(t *testing.T, response chan protocol.Frame) protocol.Frame {
	t.Helper()
	select {
	case frame := <-response:
		return frame
	case <-f.ctx.Done():
		t.Fatal(f.ctx.Err())
		return protocol.Frame{}
	}
}

// start begins Run seq and returns the native prompt the lane submitted.
func (f *laneFixture) start(t *testing.T, seq int, text string) string {
	t.Helper()
	if frame := f.answer(t, f.begin(t, "turn.execute", protocol.ExecuteRequest{SessionID: "ses_lane@local", RunID: fmt.Sprintf("g/%d", seq), Input: text})); frame.Error != nil {
		t.Fatalf("execute: %+v", frame.Error)
	}
	return f.prompt(t, text)
}

func (f *laneFixture) prompt(t *testing.T, text string) string {
	t.Helper()
	for {
		select {
		case prompt := <-f.native.notify:
			// A delivery arrives rendered in its cross-session envelope.
			if strings.Contains(prompt["text"], text) {
				return prompt["id"]
			}
		case <-f.ctx.Done():
			t.Fatalf("prompt %q not submitted", text)
		}
	}
}

func (f *laneFixture) status(t *testing.T, method string, seq int) kit.RunStatus {
	t.Helper()
	var status kit.RunStatus
	frame := f.answer(t, f.begin(t, method, kit.WaitRequest{SessionID: "ses_lane@local", RunID: fmt.Sprintf("g/%d", seq)}))
	if frame.Error != nil || json.Unmarshal(frame.Result, &status) != nil {
		t.Fatalf("%s: %+v %s", method, frame.Error, frame.Result)
	}
	return status
}

func (f *laneFixture) deliver(t *testing.T, body string) chan protocol.Frame {
	return f.begin(t, "message.deliver", kit.DeliveryRequest{MessageID: "delivery-" + body, From: kit.DeliverySource{SessionID: "sender@local", Product: "claude", Groups: []string{}}, Body: body})
}

// running checks that Run seq has not settled after the native events so far.
func (f *laneFixture) running(t *testing.T, seq int) {
	t.Helper()
	time.Sleep(150 * time.Millisecond)
	if status := f.status(t, "turn.status", seq); status.State != "running" {
		t.Fatalf("Run settled early: %+v", status)
	}
}

func (f *laneFixture) answered(own, text string) {
	f.native.mu.Lock()
	f.native.history = []map[string]any{
		{"id": "msg_zz", "type": "assistant", "finish": "stop", "content": []map[string]string{{"type": "text", "text": text}}},
		{"id": own, "type": "user"},
	}
	f.native.mu.Unlock()
}

func delivered(f *fakeNative, id string) {
	f.emit("session.inbox.enqueued", map[string]any{"sessionID": "ses_lane", "inboxID": id})
	f.emit("session.execution.started", map[string]any{"sessionID": "ses_lane"})
	f.emit("session.inbox.delivered", map[string]any{"sessionID": "ses_lane", "inboxID": id})
}

func succeeded(f *fakeNative) {
	f.emit("session.execution.succeeded", map[string]any{"sessionID": "ses_lane"})
}

// A lane whose session cannot bind the native Sessionbus plugin is refused at
// Open, before it is presented as ready; a ready lane has already bound once.
func TestLaneOpenRequiresTheSessionbusBinding(t *testing.T) {
	f := newUnopenedLaneFixture(t, nil)
	f.host.mu.Lock()
	f.host.bindErr = errors.New("OpenCode answered 400: RPC is unavailable: sessionbus")
	f.host.mu.Unlock()
	if frame := f.open(t, kit.OpenOptions{}, ""); frame.Error == nil || !strings.Contains(string(frame.Error.Data)+frame.Error.Message, "RPC is unavailable: sessionbus") {
		t.Fatalf("open without the plugin: %+v", frame.Error)
	}
	g := newLaneFixture(t, kit.OpenOptions{}, "", nil)
	g.host.mu.Lock()
	defer g.host.mu.Unlock()
	if g.host.binds != 1 {
		t.Fatalf("binds at Open = %d", g.host.binds)
	}
}

func TestLaneRunCompletesAtItsNativeTerminal(t *testing.T) {
	f := newLaneFixture(t, kit.OpenOptions{}, "", nil)
	own := f.start(t, 1, "task")
	f.answered(own, "ALPHA")
	delivered(f.native, own)
	succeeded(f.native)
	status := f.status(t, "turn.wait", 1)
	if status.State != "done" || status.Result == nil || status.Result.Outcome != "completed" || status.Result.Result != "ALPHA" || status.Result.NativeStopReason != "stop" {
		t.Fatalf("status = %+v %+v", status, status.Result)
	}
	f.native.mu.Lock()
	defer f.native.mu.Unlock()
	if rules, _ := json.Marshal(f.native.created[0]["permissions"]); string(rules) != `[{"action":"sessionbus","effect":"allow","resource":"*"}]` {
		t.Fatalf("default create rules = %s", rules)
	}
}

// A Deliver whose native answer arrives only after the terminal is admitted
// work of this Run: the Run waits for its delivery and the next terminal.
func TestLaneHeldDeliverAfterTerminalKeepsTheRunOpen(t *testing.T) {
	release := make(chan struct{})
	f := newLaneFixture(t, kit.OpenOptions{}, "", func(n *fakeNative) {
		n.holds["late"] = func(w http.ResponseWriter) {
			<-release
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{}})
		}
	})
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	receipt := f.deliver(t, "late")
	steer := f.prompt(t, "late")
	succeeded(f.native)
	f.running(t, 1)
	close(release)
	if frame := f.answer(t, receipt); frame.Error != nil || !strings.Contains(string(frame.Result), `"injected"`) {
		t.Fatalf("receipt = %+v %s", frame.Error, frame.Result)
	}
	f.running(t, 1)
	f.answered(own, "BOTH")
	delivered(f.native, steer)
	succeeded(f.native)
	if status := f.status(t, "turn.wait", 1); status.State != "done" || status.Result.Result != "BOTH" {
		t.Fatalf("status = %+v", status)
	}
}

// Native events can precede the HTTP answer: an input delivered before the
// terminal completes the Run once its request resolves.
func TestLaneHeldDeliverDeliveredBeforeTerminalCompletesOnResolve(t *testing.T) {
	release := make(chan struct{})
	f := newLaneFixture(t, kit.OpenOptions{}, "", func(n *fakeNative) {
		n.holds["early"] = func(w http.ResponseWriter) {
			<-release
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{}})
		}
	})
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	receipt := f.deliver(t, "early")
	steer := f.prompt(t, "early")
	f.native.emit("session.inbox.enqueued", map[string]any{"sessionID": "ses_lane", "inboxID": steer})
	f.native.emit("session.inbox.delivered", map[string]any{"sessionID": "ses_lane", "inboxID": steer})
	f.answered(own, "DONE")
	succeeded(f.native)
	time.Sleep(150 * time.Millisecond)
	close(release)
	f.answer(t, receipt)
	if status := f.status(t, "turn.wait", 1); status.State != "done" || status.Result.Result != "DONE" {
		t.Fatalf("status = %+v", status)
	}
}

// A broken answer after native visibly admitted the input is still admission.
func TestLaneAmbiguousDeliverWithObservedAdmissionIsInjected(t *testing.T) {
	var f *laneFixture
	f = newLaneFixture(t, kit.OpenOptions{}, "", func(n *fakeNative) {
		n.holds["seen"] = func(w http.ResponseWriter) {
			n.mu.Lock()
			id := n.prompts[len(n.prompts)-1]["id"]
			n.mu.Unlock()
			n.emit("session.inbox.enqueued", map[string]any{"sessionID": "ses_lane", "inboxID": id})
			time.Sleep(100 * time.Millisecond)
			breakResponse(w)
		}
	})
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	receipt := f.deliver(t, "seen")
	steer := f.prompt(t, "seen")
	if frame := f.answer(t, receipt); frame.Error != nil || !strings.Contains(string(frame.Result), `"injected"`) {
		t.Fatalf("receipt = %+v %s", frame.Error, frame.Result)
	}
	succeeded(f.native)
	f.running(t, 1)
	f.answered(own, "OK")
	f.native.emit("session.execution.started", map[string]any{"sessionID": "ses_lane"})
	f.native.emit("session.inbox.delivered", map[string]any{"sessionID": "ses_lane", "inboxID": steer})
	succeeded(f.native)
	if status := f.status(t, "turn.wait", 1); status.State != "done" {
		t.Fatalf("status = %+v", status)
	}
}

// An answer that leaves admission unknown is -32603 and is never replayed, and
// the Run cannot then claim a completed result.
func TestLaneAmbiguousDeliverWithoutAdmissionIsInternalAndNotReplayed(t *testing.T) {
	f := newLaneFixture(t, kit.OpenOptions{}, "", func(n *fakeNative) { n.holds["lost"] = breakResponse })
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	receipt := f.deliver(t, "lost")
	f.prompt(t, "lost")
	if frame := f.answer(t, receipt); frame.Error == nil || frame.Error.Code != protocol.Internal {
		t.Fatalf("receipt = %+v %s", frame.Error, frame.Result)
	}
	f.answered(own, "OK")
	succeeded(f.native)
	if status := f.status(t, "turn.wait", 1); status.State != "unavailable" || status.Result != nil {
		t.Fatalf("status = %+v", status)
	}
	f.native.mu.Lock()
	defer f.native.mu.Unlock()
	count := 0
	for _, p := range f.native.prompts {
		if strings.Contains(p["text"], "lost") {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("delivery submitted %d times", count)
	}
}

func TestLaneFailedTerminalSettlesWithUndeliveredInputs(t *testing.T) {
	f := newLaneFixture(t, kit.OpenOptions{}, "", nil)
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	f.answer(t, f.deliver(t, "pending"))
	f.native.emit("session.execution.failed", map[string]any{"sessionID": "ses_lane", "error": map[string]string{"type": "provider.auth", "message": "no key"}})
	status := f.status(t, "turn.wait", 1)
	if status.State != "done" || status.Result.Outcome != "failed" || status.Result.NativeStopReason != "provider.auth" || status.Result.Result != "no key" {
		t.Fatalf("status = %+v %+v", status, status.Result)
	}
	frame := f.answer(t, f.deliver(t, "after"))
	if frame.Error == nil || frame.Error.Code != protocol.NotRunning {
		t.Fatalf("deliver after terminal = %+v", frame.Error)
	}
}

// Asks and forms of the lane's sessions are declined with a fixed message;
// other sessions on the same server are left alone.
func TestLaneDeclinesOnlyItsOwnSessionsAsks(t *testing.T) {
	f := newLaneFixture(t, kit.OpenOptions{}, "", func(n *fakeNative) {
		n.sessions["ses_child"] = nativeSession{ID: "ses_child", ParentID: "ses_lane"}
		n.sessions["ses_other"] = nativeSession{ID: "ses_other"}
	})
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	f.native.emit("permission.asked", map[string]any{"id": "per_other", "sessionID": "ses_other"})
	f.native.emit("permission.asked", map[string]any{"id": "per_child", "sessionID": "ses_child"})
	f.native.emit("form.created", map[string]any{"form": map[string]any{"id": "frm_1", "sessionID": "ses_lane", "metadata": map[string]string{"kind": "question"}}})
	f.native.emit("form.created", map[string]any{"form": map[string]any{"id": "frm_2", "sessionID": "ses_lane", "metadata": map[string]string{"kind": "oauth"}}})
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.native.mu.Lock()
		replies := strings.Join(f.native.replies, "\n")
		f.native.mu.Unlock()
		if strings.Contains(replies, "per_child") && strings.Contains(replies, "frm_2") {
			if strings.Contains(replies, "per_other") || !strings.Contains(replies, `"decision":"reject"`) || !strings.Contains(replies, `"message":"Declined: `) || !strings.Contains(replies, "frm_1?message=Declined") || !strings.Contains(replies, "frm_2? ") {
				t.Fatalf("replies = %s", replies)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("replies = %s", replies)
		}
		time.Sleep(20 * time.Millisecond)
	}
	f.native.emit("session.execution.interrupted", map[string]any{"sessionID": "ses_lane", "reason": "shutdown"})
	status := f.status(t, "turn.wait", 1)
	if status.Result.Outcome != "interrupted" || status.Result.NativeStopReason != "shutdown" || status.Result.Result != "run ended by permission rejection" {
		t.Fatalf("status = %+v", status.Result)
	}
}

func TestLaneShutdownWithoutRejectionKeepsNativeReasonOnly(t *testing.T) {
	f := newLaneFixture(t, kit.OpenOptions{}, "", nil)
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	f.native.emit("session.execution.interrupted", map[string]any{"sessionID": "ses_lane", "reason": "shutdown"})
	if status := f.status(t, "turn.wait", 1); status.Result.Outcome != "interrupted" || status.Result.NativeStopReason != "shutdown" || status.Result.Result != "" {
		t.Fatalf("status = %+v", status.Result)
	}
}

func TestLaneResultRequiresItsOwnPrompt(t *testing.T) {
	f := newLaneFixture(t, kit.OpenOptions{}, "", nil)
	own := f.start(t, 1, "task")
	f.answered("msg_someone_else", "STALE")
	delivered(f.native, own)
	succeeded(f.native)
	if status := f.status(t, "turn.wait", 1); status.State != "unavailable" {
		t.Fatalf("status = %+v", status)
	}
}

func TestLaneNativeLossMakesTheRunUnavailable(t *testing.T) {
	f := newLaneFixture(t, kit.OpenOptions{}, "", nil)
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	close(f.native.drop)
	if status := f.status(t, "turn.wait", 1); status.State != "unavailable" {
		t.Fatalf("status = %+v", status)
	}
	select {
	case <-f.closes:
	case <-f.ctx.Done():
		t.Fatal("lane did not retire after native loss")
	}
}

func TestLaneBypassResumeKeepsRulesAndEndsWithTheGrant(t *testing.T) {
	f := newLaneFixture(t, kit.OpenOptions{PermissionMode: "bypassPermissions"}, "ses_lane", func(n *fakeNative) {
		n.sessions["ses_lane"] = nativeSession{ID: "ses_lane", Permissions: []permissionRule{{Action: "edit", Resource: "*", Effect: "ask"}, grantRule}}
	})
	f.native.mu.Lock()
	defer f.native.mu.Unlock()
	rules, _ := json.Marshal(f.native.patched[0]["permissions"])
	if string(rules) != `[{"action":"edit","effect":"ask","resource":"*"},{"action":"*","effect":"allow","resource":"*"},{"action":"sessionbus","effect":"allow","resource":"*"}]` {
		t.Fatalf("resume rules = %s", rules)
	}
}

func TestLaneArgumentsAndModel(t *testing.T) {
	options, err := parseLaneOptions(kit.OpenOptions{Model: "deepseek/deepseek-v4-pro", Arguments: []string{"--agent=build"}})
	if err != nil || options.agent != "build" || options.model.ProviderID != "deepseek" || options.model.ID != "deepseek-v4-pro" {
		t.Fatalf("options = %+v %v", options, err)
	}
	for _, bad := range [][]string{{"--port", "1"}, {"--mdns"}, {"--auto"}, {"--print-logs"}, {"--agent", "a", "--agent", "b"}} {
		if _, err := parseLaneOptions(kit.OpenOptions{Arguments: bad}); err == nil {
			t.Fatalf("%v accepted", bad)
		}
	}
	if _, err := parseLaneOptions(kit.OpenOptions{PermissionMode: "plan"}); err == nil {
		t.Fatal("unknown permission mode accepted")
	}
}

// A delivery inside a successor execution is not that successor's end: the Run
// waits for the terminal after it, even when the request resolves in between.
func TestLaneSuccessorDeliveryNeedsItsOwnTerminal(t *testing.T) {
	release := make(chan struct{})
	f := newLaneFixture(t, kit.OpenOptions{}, "", func(n *fakeNative) {
		n.holds["next"] = func(w http.ResponseWriter) {
			<-release
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{}})
		}
	})
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	receipt := f.deliver(t, "next")
	steer := f.prompt(t, "next")
	succeeded(f.native)
	delivered(f.native, steer)
	time.Sleep(100 * time.Millisecond)
	close(release)
	f.answer(t, receipt)
	f.running(t, 1)
	f.answered(own, "AFTER")
	succeeded(f.native)
	if status := f.status(t, "turn.wait", 1); status.State != "done" || status.Result.Result != "AFTER" {
		t.Fatalf("status = %+v", status)
	}
}

// Asks of other sessions on a shared server cost lookups, never the lane.
func TestLaneUnrelatedAsksDoNotEndTheLane(t *testing.T) {
	f := newLaneFixture(t, kit.OpenOptions{}, "", func(n *fakeNative) {
		n.slowGet = 100 * time.Millisecond
		for i := 0; i < 9; i++ {
			n.sessions[fmt.Sprintf("ses_other%d", i)] = nativeSession{ID: fmt.Sprintf("ses_other%d", i)}
		}
	})
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	for i := 0; i < 9; i++ {
		f.native.emit("permission.asked", map[string]any{"id": fmt.Sprintf("per_%d", i), "sessionID": fmt.Sprintf("ses_other%d", i)})
	}
	f.answered(own, "OK")
	succeeded(f.native)
	if status := f.status(t, "turn.wait", 1); status.State != "done" {
		t.Fatalf("status = %+v", status)
	}
	f.native.mu.Lock()
	defer f.native.mu.Unlock()
	if len(f.native.replies) != 0 {
		t.Fatalf("replies = %v", f.native.replies)
	}
}

// An ask another client already answered is not pending: skipping it keeps
// the lane.
func TestLaneSkipsAnAskAnotherClientSettled(t *testing.T) {
	f := newLaneFixture(t, kit.OpenOptions{}, "", func(n *fakeNative) { n.settled["per_gone"] = true })
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	f.native.emit("permission.asked", map[string]any{"id": "per_gone", "sessionID": "ses_lane"})
	f.answered(own, "OK")
	succeeded(f.native)
	if status := f.status(t, "turn.wait", 1); status.State != "done" || status.Result.Result != "OK" {
		t.Fatalf("status = %+v", status)
	}
}

// Only native's declared pre-admission errors refuse an input; a failure that
// can follow admission leaves the outcome unknown.
func TestLaneDeliverRefusalNeedsADeclaredPreAdmissionError(t *testing.T) {
	answer := func(code int, tag string) func(http.ResponseWriter) {
		return func(w http.ResponseWriter) {
			w.WriteHeader(code)
			json.NewEncoder(w).Encode(map[string]string{"_tag": tag})
		}
	}
	f := newLaneFixture(t, kit.OpenOptions{}, "", func(n *fakeNative) {
		n.holds["conflict"] = answer(http.StatusConflict, "ConflictError")
		n.holds["wake"] = answer(http.StatusInternalServerError, "UnknownError")
	})
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	if frame := f.answer(t, f.deliver(t, "conflict")); frame.Error != nil || !strings.Contains(string(frame.Result), `"rejected"`) {
		t.Fatalf("declared refusal = %+v %s", frame.Error, frame.Result)
	}
	if frame := f.answer(t, f.deliver(t, "wake")); frame.Error == nil || frame.Error.Code != protocol.Internal {
		t.Fatalf("post-admission failure = %+v %s", frame.Error, frame.Result)
	}
}

// A released delivery that native then visibly admits before the terminal is
// tracked again and completes the Run normally.
func TestLaneReleasedDeliverSeenBeforeTerminalIsTrackedAgain(t *testing.T) {
	f := newLaneFixture(t, kit.OpenOptions{}, "", func(n *fakeNative) { n.holds["late"] = breakResponse })
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	receipt := f.deliver(t, "late")
	steer := f.prompt(t, "late")
	if frame := f.answer(t, receipt); frame.Error == nil || frame.Error.Code != protocol.Internal {
		t.Fatalf("receipt = %+v", frame.Error)
	}
	f.native.emit("session.inbox.enqueued", map[string]any{"sessionID": "ses_lane", "inboxID": steer})
	f.native.emit("session.inbox.delivered", map[string]any{"sessionID": "ses_lane", "inboxID": steer})
	f.answered(own, "BOTH")
	succeeded(f.native)
	if status := f.status(t, "turn.wait", 1); status.State != "done" || status.Result.Result != "BOTH" {
		t.Fatalf("status = %+v", status)
	}
}

// Native can fail before promoting our prompt (for example while preparing the
// step's agent). After our admission and before our delivery the terminal may
// also be earlier work's, so the Run is unavailable with the native context; a
// terminal before our admission is ignored. Worker Close then completes.
func TestLaneFailureBeforeOurDeliveryEndsTheRunAsUnknown(t *testing.T) {
	f := newLaneFixture(t, kit.OpenOptions{}, "", nil)
	own := f.start(t, 1, "task")
	f.native.emit("session.execution.failed", map[string]any{"sessionID": "ses_lane", "error": map[string]string{"type": "earlier", "message": "not ours"}})
	f.running(t, 1)
	f.native.emit("session.inbox.enqueued", map[string]any{"sessionID": "ses_lane", "inboxID": own})
	f.native.emit("session.execution.started", map[string]any{"sessionID": "ses_lane"})
	f.native.emit("session.execution.failed", map[string]any{"sessionID": "ses_lane", "error": map[string]string{"type": "AgentNotFoundError", "message": "Agent not found"}})
	status := f.status(t, "turn.wait", 1)
	if status.State != "unavailable" || status.Result != nil || !strings.Contains(status.Reason, "AgentNotFoundError") {
		t.Fatalf("status = %+v", status)
	}
	if frame := f.answer(t, f.begin(t, "session.close", kit.SessionCloseRequest{SessionID: "ses_lane@local"})); frame.Error != nil {
		t.Fatalf("close = %+v", frame.Error)
	}
}

func (f *laneFixture) interrupt(t *testing.T) {
	t.Helper()
	if frame := f.answer(t, f.begin(t, "turn.interrupt", protocol.SessionTarget{SessionID: "ses_lane@local"})); frame.Error != nil {
		t.Fatalf("interrupt: %+v", frame.Error)
	}
}

func (f *fakeNative) withdrawn() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var ids []string
	for _, reply := range f.replies {
		if id, ok := strings.CutPrefix(reply, "withdraw "); ok {
			ids = append(ids, id)
		}
	}
	return ids
}

// A cancelled Run withdraws the steers native has not delivered before it
// ends, after the native interrupt; the Run's own prompt and delivered steers
// are left alone, and the cancelling Run takes no further input.
func TestLaneInterruptWithdrawsItsUndeliveredSteers(t *testing.T) {
	f := newLaneFixture(t, kit.OpenOptions{}, "", nil)
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	receipt := f.deliver(t, "seen")
	seen := f.prompt(t, "seen")
	f.answer(t, receipt)
	f.native.emit("session.inbox.delivered", map[string]any{"sessionID": "ses_lane", "inboxID": seen})
	receipt = f.deliver(t, "pending")
	pending := f.prompt(t, "pending")
	if frame := f.answer(t, receipt); frame.Error != nil || !strings.Contains(string(frame.Result), `"injected"`) {
		t.Fatalf("receipt = %+v %s", frame.Error, frame.Result)
	}
	f.running(t, 1)
	f.interrupt(t)
	if frame := f.answer(t, f.deliver(t, "after")); frame.Error == nil || frame.Error.Code != protocol.NotRunning {
		t.Fatalf("deliver while cancelling = %+v %s", frame.Error, frame.Result)
	}
	f.native.emit("session.execution.interrupted", map[string]any{"sessionID": "ses_lane", "reason": "user"})
	if status := f.status(t, "turn.wait", 1); status.Result.Outcome != "interrupted" || status.Result.Result != "" {
		t.Fatalf("status = %+v %+v", status, status.Result)
	}
	f.native.mu.Lock()
	replies := slices.Clone(f.native.replies)
	f.native.mu.Unlock()
	if want := []string{"interrupt resume=false", "withdraw " + pending}; !slices.Equal(replies, want) {
		t.Fatalf("native calls = %q, want %q", replies, want)
	}
}

// A steer still in flight when its Run is cancelled is withdrawn again once
// its request answers, since native may have admitted it after the Run ended.
func TestLaneSteerInFlightAtInterruptIsWithdrawnAfterItsAnswer(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	f := newLaneFixture(t, kit.OpenOptions{}, "", func(n *fakeNative) {
		n.holds["late"] = func(w http.ResponseWriter) {
			<-release
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{}})
		}
	})
	t.Cleanup(unblock)
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	receipt := f.deliver(t, "late")
	late := f.prompt(t, "late")
	f.interrupt(t)
	f.native.emit("session.execution.interrupted", map[string]any{"sessionID": "ses_lane", "reason": "user"})
	f.status(t, "turn.wait", 1)
	if got := f.native.withdrawn(); !slices.Equal(got, []string{late}) {
		t.Fatalf("withdrawn at the Run's end = %q", got)
	}
	unblock()
	if frame := f.answer(t, receipt); frame.Error != nil {
		t.Fatalf("receipt = %+v", frame.Error)
	}
	if got := f.native.withdrawn(); !slices.Equal(got, []string{late, late}) {
		t.Fatalf("withdrawn after the answer = %q", got)
	}
}

// A steer whose request answers before its cancelled Run's terminal is left
// to the Run's withdrawal, so a failed interrupt cannot have dropped it.
func TestLaneSteerAnsweredBeforeTheTerminalIsWithdrawnOnceByTheRun(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	f := newLaneFixture(t, kit.OpenOptions{}, "", func(n *fakeNative) {
		n.holds["early"] = func(w http.ResponseWriter) {
			<-release
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{}})
		}
	})
	t.Cleanup(unblock)
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	receipt := f.deliver(t, "early")
	early := f.prompt(t, "early")
	f.interrupt(t)
	unblock()
	if frame := f.answer(t, receipt); frame.Error != nil || !strings.Contains(string(frame.Result), `"injected"`) {
		t.Fatalf("receipt = %+v %s", frame.Error, frame.Result)
	}
	if got := f.native.withdrawn(); len(got) != 0 {
		t.Fatalf("withdrawn before the terminal = %q", got)
	}
	f.native.emit("session.execution.interrupted", map[string]any{"sessionID": "ses_lane", "reason": "user"})
	f.status(t, "turn.wait", 1)
	if got := f.native.withdrawn(); !slices.Equal(got, []string{early}) {
		t.Fatalf("withdrawn by the Run = %q", got)
	}
}

// An interrupt call that fails after native already ended the Run keeps it
// cancelled, so a steer answering later is still withdrawn.
func TestLaneInterruptErrorAfterTheTerminalKeepsTheRunCancelled(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	f := newLaneFixture(t, kit.OpenOptions{}, "", func(n *fakeNative) {
		n.holds["late"] = func(w http.ResponseWriter) {
			<-release
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{}})
		}
		n.halt = func() int {
			// The Run ends and takes its snapshot before the call fails.
			n.emit("session.execution.interrupted", map[string]any{"sessionID": "ses_lane", "reason": "user"})
			time.Sleep(300 * time.Millisecond)
			return http.StatusBadGateway
		}
	})
	t.Cleanup(unblock)
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	receipt := f.deliver(t, "late")
	late := f.prompt(t, "late")
	f.interrupt(t)
	unblock()
	f.answer(t, receipt)
	if got := f.native.withdrawn(); !slices.Equal(got, []string{late, late}) {
		t.Fatalf("withdrawn = %q", got)
	}
}

// A withdrawal native does not confirm is reported with the interrupted
// terminal and is not retried; the lane stays usable.
func TestLaneUnconfirmedWithdrawalIsReportedAndKeepsTheLane(t *testing.T) {
	f := newLaneFixture(t, kit.OpenOptions{}, "", func(n *fakeNative) { n.withdraw = http.StatusInternalServerError })
	own := f.start(t, 1, "task")
	delivered(f.native, own)
	receipt := f.deliver(t, "pending")
	f.prompt(t, "pending")
	f.answer(t, receipt)
	f.interrupt(t)
	f.native.emit("session.execution.interrupted", map[string]any{"sessionID": "ses_lane", "reason": "user"})
	status := f.status(t, "turn.wait", 1)
	if status.State != "done" || status.Result.Outcome != "interrupted" || status.Result.Result != "pending input was not withdrawn and may run with the next task" {
		t.Fatalf("status = %+v %+v", status, status.Result)
	}
	if got := f.native.withdrawn(); len(got) != 1 {
		t.Fatalf("withdrawals = %q", got)
	}
	if frame := f.answer(t, f.begin(t, "turn.ack", protocol.RunRef{SessionID: "ses_lane@local", RunID: "g/1"})); frame.Error != nil {
		t.Fatalf("ack: %+v", frame.Error)
	}
	f.start(t, 2, "next")
	select {
	case <-f.closes:
		t.Fatal("lane retired after an unconfirmed withdrawal")
	default:
	}
}

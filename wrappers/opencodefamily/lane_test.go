// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/antst/sessionbus/bus/sdk/go/protocol"
	"github.com/sessionbus/peer-common/host"
	"github.com/sessionbus/peer-common/testsocket"
)

func TestMain(m *testing.M) {
	if os.Getenv("OPENCODE_TEST_NATIVE") == "1" || os.Getenv("KILO_TEST_NATIVE") == "1" {
		fakeNativeHTTP()
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func fakePart(session, id, kind, text string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"sessionID": session, "messageID": id, "type": kind, "text": text})
	return b
}
func fakeNativeHTTP() {
	kind := openCodeNative
	nativeName, authPrefix := "opencode", "OPENCODE"
	if os.Getenv("KILO_TEST_NATIVE") == "1" {
		kind = kiloNative
		nativeName, authPrefix = "kilo", "KILO"
		if os.Getenv("KILO_PARENT_PID") != strconv.Itoa(os.Getppid()) || os.Getenv("SESSIONBUS_KILO_LAUNCH") != "" {
			os.Exit(8)
		}
	}
	if mode := os.Getenv("OPENCODE_TEST_OPEN_MODE"); mode != "" {
		fakeOpenFailureNative(mode, kind)
		return
	}
	if os.Getenv("OPENCODE_REVIEW_ROLLBACK_NOTIFY") != "" {
		reviewStalledRollbackNative(kind)
		return
	}
	cwd, _ := os.Getwd()
	id := "ses_native"
	if strings.Join(os.Args[1:], " ") != "serve --hostname 127.0.0.1 --port 0" {
		os.Exit(5)
	}
	for _, key := range []string{host.SocketEnv, host.LocalKeyEnv, host.TokenEnv, host.SessionIDEnv, host.NameEnv, host.GroupsEnv, opencodeInteractiveLaunchEnv} {
		if os.Getenv(key) != "" {
			os.Exit(6)
		}
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	var mu sync.Mutex
	var history []withParts
	var aborts int
	var rejections int
	var creates, loads, patches, deletes int
	var hold chan struct{}
	var interrupted bool
	var permission any
	var holdProjection bool
	projectionStarted := make(chan struct{})
	var projectionOnce sync.Once
	events := make(chan any, 256)
	eventEnd := make(chan struct{})
	started := make(chan struct{})
	var startOnce sync.Once
	var helper net.Conn
	helperEnded := make(chan struct{})
	termSeen := make(chan struct{})
	closeRelease := make(chan struct{})
	var closeReleaseOnce sync.Once
	var init sync.Once
	emit := func(kind string, properties any) { events <- map[string]any{"type": kind, "properties": properties} }
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, ok := r.BasicAuth()
		if !ok || u != os.Getenv(authPrefix+"_SERVER_USERNAME") || p != os.Getenv(authPrefix+"_SERVER_PASSWORD") || r.Header.Get("x-"+nativeName+"-directory") != cwd || r.URL.Query().Get("directory") != cwd {
			http.Error(w, "scope", 403)
			return
		}
		reply := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		switch {
		case r.URL.Path == "/event":
			init.Do(func() {
				helper, err = net.Dial("unix", os.Getenv(LaneSocketEnv))
				if err != nil {
					panic(err)
				}
				_, _ = io.WriteString(helper, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"fake-native\",\"version\":\"1\"}}}\n")
				_, err = bufio.NewReader(helper).ReadBytes('\n')
				if err != nil {
					panic(err)
				}
				if kind == kiloNative {
					go func() { _, _ = io.Copy(io.Discard, helper); close(helperEnded) }()
				}
			})
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"type\":\"server.connected\",\"properties\":{}}\n\n")
			w.(http.Flusher).Flush()
			for {
				select {
				case e := <-events:
					b, _ := json.Marshal(e)
					_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
					w.(http.Flusher).Flush()
				case <-eventEnd:
					return
				case <-r.Context().Done():
					return
				}
			}
		case r.URL.Path == "/experimental/tool/ids":
			reply([]string{ToolName})
		case r.URL.Path == "/session" && r.Method == "POST" || r.URL.Path == "/session/"+id && r.Method == "PATCH":
			var req map[string]any
			_ = json.NewDecoder(r.Body).Decode(&req)
			mu.Lock()
			permission = req["permission"]
			if r.Method == "POST" {
				creates++
			} else {
				patches++
			}
			mu.Unlock()
			reply(nativeSession{ID: id, Title: req["title"].(string), Directory: cwd})
		case r.URL.Path == "/session/"+id && r.Method == "GET":
			mu.Lock()
			loads++
			mu.Unlock()
			reply(nativeSession{ID: id, Title: "lane", Directory: cwd})
		case r.URL.Path == "/session/ses_child":
			reply(nativeSession{ID: "ses_child", ParentID: id, Directory: cwd})
		case r.URL.Path == "/session/ses_other":
			reply(nativeSession{ID: "ses_other", Directory: cwd})
		case r.URL.Path == "/session/"+id && r.Method == "DELETE":
			mu.Lock()
			deletes++
			mu.Unlock()
			reply(true)
		case r.URL.Path == "/session/"+id+"/message" && r.Method == "GET":
			mu.Lock()
			copy := append([]withParts{}, history...)
			held := holdProjection
			mu.Unlock()
			if held {
				projectionOnce.Do(func() { close(projectionStarted) })
				<-r.Context().Done()
				return
			}
			if os.Getenv("OPENCODE_TEST_SUMMARY") == "history" {
				reply(reviewSummaryHistory(copy))
				return
			}
			reply(copy)
		case r.URL.Path == "/session/"+id+"/message" && r.Method == "POST":
			var req struct {
				MessageID string `json:"messageID"`
				NoReply   bool   `json:"noReply"`
				Parts     []struct {
					Text string `json:"text"`
				} `json:"parts"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			if kind == kiloNative && (req.NoReply || len(req.MessageID) != 30) {
				http.Error(w, "Kilo requires one native-shaped explicit prompt and no noReply", 400)
				return
			}
			text := req.Parts[0].Text
			user := withParts{Info: nativeInfo{ID: req.MessageID, SessionID: id, Role: "user"}, Parts: []json.RawMessage{fakePart(id, req.MessageID, "text", text)}}
			mu.Lock()
			history = append(history, user)
			holdProjection = text == "projection-held"
			mu.Unlock()
			if mode := os.Getenv("OPENCODE_TEST_SUMMARY"); mode == "event-user" {
				emit("message.updated", map[string]any{"sessionID": id, "info": reviewUserSummary(user.Info)})
			} else if mode == "event-session" {
				emit("session.updated", map[string]any{"sessionID": id, "info": map[string]any{"id": id, "summary": map[string]int{"additions": 0, "deletions": 0, "files": 0}}})
			}
			emit("message.updated", map[string]any{"info": user.Info})
			if req.NoReply {
				reply(user)
				return
			}
			mu.Lock()
			interrupted = false
			hold = make(chan struct{})
			gate := hold
			mu.Unlock()
			emit("session.status", map[string]any{"sessionID": id, "status": map[string]string{"type": "busy"}})
			startOnce.Do(func() { close(started) })
			if text == "hold-permission" {
				emit("permission.asked", map[string]any{"id": "per_fixture", "sessionID": id, "permission": "bash", "patterns": []string{"fixture"}, "metadata": map[string]any{}})
			}
			if text == "hold-question" || strings.HasPrefix(text, "review-plan-") {
				emit("question.asked", map[string]any{"id": "que_fixture", "sessionID": id, "questions": []any{}})
			}
			if strings.HasPrefix(text, "hold") || strings.HasPrefix(text, "review-plan-") {
				select {
				case <-gate:
				case <-r.Context().Done():
					return
				}
			}
			mu.Lock()
			parent := req.MessageID
			for _, m := range history {
				if m.Info.Role == "user" {
					parent = m.Info.ID
				}
			}
			answer := withParts{Info: nativeInfo{ID: "msg_answer_" + strconv.Itoa(len(history)), SessionID: id, ParentID: parent, Role: "assistant", Finish: "stop"}}
			now := float64(1)
			answer.Info.Time.Completed = &now
			answer.Parts = []json.RawMessage{fakePart(id, answer.Info.ID, "text", "answer:"+text)}
			if interrupted && text == "hold-summary" {
				answer.Info.Summary = true
			}
			if interrupted && text == "hold-toolcalls" {
				answer.Info.Finish = "tool-calls"
			}
			if strings.HasPrefix(text, "hold-terminal-") {
				variant := strings.TrimPrefix(text, "hold-terminal-")
				if variant == "unknown" {
					answer.Info.Finish = "unknown"
				}
				if variant != "stop" && variant != "unknown" {
					part := map[string]any{"type": "tool", "sessionID": id, "messageID": answer.Info.ID, "tool": "fixture", "callID": "call_fixture", "state": map[string]any{"status": "completed", "input": map[string]any{}, "output": "done", "title": "fixture", "time": map[string]int{"start": 1, "end": 2}}}
					if variant == "provider" {
						part["metadata"] = map[string]bool{"providerExecuted": true}
					}
					if variant == "orphan" {
						part["state"] = map[string]any{"status": "error", "input": map[string]any{}, "error": "interrupted", "metadata": map[string]bool{"interrupted": true}, "time": map[string]int{"start": 1, "end": 2}}
					}
					raw, _ := json.Marshal(part)
					answer.Parts = append(answer.Parts, raw)
				}
			}
			if strings.HasPrefix(text, "review-plan-") {
				answer.Info.Finish = strings.TrimPrefix(text, "review-plan-")
				part := map[string]any{"type": "tool", "sessionID": id, "messageID": answer.Info.ID, "tool": "plan_exit", "callID": "call_plan", "state": map[string]any{"status": "completed", "input": map[string]any{}, "output": "Plan ready", "title": "Plan", "metadata": map[string]any{}, "time": map[string]int{"start": 1, "end": 2}}}
				raw, _ := json.Marshal(part)
				answer.Parts = append(answer.Parts, raw)
			}
			if interrupted && text != "hold-summary" && text != "hold-toolcalls" && !strings.HasPrefix(text, "hold-terminal-") {
				answer.Info.Error = json.RawMessage(`{"name":"MessageAbortedError","data":{"message":"aborted"}}`)
			}
			if strings.HasPrefix(text, "plan-") || strings.HasPrefix(text, "hold-plan") {
				history = kiloPlanFixture(text, id, req.MessageID, history, &answer)
			}
			history = append(history, answer)
			hold = nil
			mu.Unlock()
			reply(answer)
		case r.URL.Path == "/session/"+id+"/abort":
			if kind == kiloNative && r.URL.Query().Get("scope") != "" {
				http.Error(w, "must retain native default tree cancellation", 400)
				return
			}
			mu.Lock()
			aborts++
			interrupted = true
			if hold != nil {
				close(hold)
				hold = nil
			}
			mu.Unlock()
			reply(true)
		case r.URL.Path == "/permission/per_fixture/reply" || r.URL.Path == "/question/que_fixture/reject":
			if r.Method != "POST" {
				http.Error(w, "method", 405)
				return
			}
			if r.URL.Path == "/permission/per_fixture/reply" {
				var body struct {
					Reply string `json:"reply"`
				}
				if json.NewDecoder(r.Body).Decode(&body) != nil || body.Reply != "reject" {
					http.Error(w, "must reject", 400)
					return
				}
			}
			mu.Lock()
			rejections++
			if hold != nil {
				close(hold)
				hold = nil
			}
			mu.Unlock()
			reply(true)
		case r.URL.Path == "/fixture/term":
			select {
			case <-termSeen:
				reply(true)
			case <-r.Context().Done():
			}
		case r.URL.Path == "/fixture/close-release":
			w.Header().Set("Content-Length", "4")
			_, _ = io.WriteString(w, "true")
			w.(http.Flusher).Flush()
			closeReleaseOnce.Do(func() { close(closeRelease) })
		case r.URL.Path == "/fixture/projection-pending":
			select {
			case <-projectionStarted:
				reply(true)
			case <-r.Context().Done():
			}
		case r.URL.Path == "/fixture/started":
			select {
			case <-started:
				reply(true)
			case <-r.Context().Done():
			}
		case r.URL.Path == "/fixture/exit":
			os.Exit(7)
		case r.URL.Path == "/fixture/end-events":
			close(eventEnd)
			reply(true)
		case r.URL.Path == "/fixture/release":
			mu.Lock()
			if hold != nil {
				close(hold)
				hold = nil
			}
			mu.Unlock()
			reply(true)
		case r.URL.Path == "/fixture/state":
			mu.Lock()
			reply(map[string]any{"aborts": aborts, "messages": history, "permission": permission, "rejections": rejections, "creates": creates, "loads": loads, "patches": patches, "deletes": deletes})
			mu.Unlock()
		default:
			http.Error(w, r.URL.Path, 404)
		}
	})}
	if kind == kiloNative {
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, syscall.SIGTERM)
		defer signal.Stop(signals)
		go func() {
			<-signals
			mu.Lock()
			if expected := os.Getenv("KILO_TEST_EXPECT_DELETE"); expected != "" && expected != strconv.Itoa(deletes) {
				os.Exit(9)
			}
			mu.Unlock()
			close(termSeen)
			if os.Getenv("KILO_TEST_HOLD_CLOSE") == "1" {
				<-closeRelease
			}
			// Native disposal cannot finish until the owned endpoint releases
			// the resident request/stream. This is a controlled disposal gate.
			<-helperEnded
			_ = srv.Close()
		}()
	}
	fmt.Printf("%s server listening on http://%s\n", nativeName, l.Addr())
	_ = srv.Serve(l)
}

type workerFixture struct {
	p       *Wrapper
	worker  *kit.Worker
	c       net.Conn
	mu      sync.Mutex
	next    int64
	pending map[int64]chan protocol.Frame
	ready   chan protocol.Frame
	done    chan struct{}
	ctx     context.Context
}

func newWorkerFixture(t *testing.T) *workerFixture {
	return newWorkerProductFixture(t, nil)
}
func newWorkerProductFixture(t *testing.T, decorate func(*Wrapper) kit.WorkerCallbacks) *workerFixture {
	return newWorkerKindFixture(t, openCodeNative, decorate)
}
func newWorkerKindFixture(t *testing.T, kind nativeKind, decorate func(*Wrapper) kit.WorkerCallbacks) *workerFixture {
	return newWorkerRequestFixture(t, kind, decorate, "")
}
func newWorkerRequestFixture(t *testing.T, kind nativeKind, decorate func(*Wrapper) kit.WorkerCallbacks, resume string) *workerFixture {
	t.Helper()
	return newWorkerOpenPolicyFixture(t, kind, decorate, resume, "")
}
func newWorkerOpenPolicyFixture(t *testing.T, kind nativeKind, decorate func(*Wrapper) kit.WorkerCallbacks, resume, permission string) *workerFixture {
	t.Helper()
	dir := testsocket.Directory(t)
	socket := filepath.Join(dir, "bus.sock")
	l, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(host.SocketEnv, socket)
	t.Setenv(host.TokenEnv, "token")
	if kind == kiloNative {
		t.Setenv("KILO_TEST_NATIVE", "1")
		t.Setenv("KILO_PARENT_PID", "1")
		t.Setenv("SESSIONBUS_KILO_LAUNCH", `{"foreign":"kilo launch"}`)
	} else {
		t.Setenv("OPENCODE_TEST_NATIVE", "1")
	}
	t.Setenv(opencodeInteractiveLaunchEnv, `{"foreign":"interactive launch"}`)
	path, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	p := NewOpenCode(socket, "unused", path)
	if kind == kiloNative {
		p = NewKilo(socket, "unused", path)
	}
	var product kit.WorkerCallbacks = p
	if decorate != nil {
		product = decorate(p)
	}
	worker := kit.NewWorker(product)
	p.SetCaller(worker.Caller())
	p.SetShutdown(worker.Shutdown)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	served := make(chan error, 1)
	go func() { served <- worker.Serve(ctx) }()
	c, err := l.Accept()
	if err != nil {
		t.Fatal(err)
	}
	_ = c.SetDeadline(time.Now().Add(20 * time.Second))
	f := &workerFixture{p: p, worker: worker, c: c, pending: map[int64]chan protocol.Frame{}, ready: make(chan protocol.Frame, 256), done: make(chan struct{}), ctx: ctx}
	hello := make(chan struct{})
	go func() {
		defer close(f.done)
		r := bufio.NewReader(c)
		for {
			line, err := r.ReadBytes('\n')
			if err != nil {
				return
			}
			frame, err := protocol.DecodeFrame(line[:len(line)-1])
			if err != nil {
				panic(err)
			}
			f.mu.Lock()
			if frame.Method != "" {
				result := map[string]any{}
				if frame.Method == "session.list" {
					result["sessions"] = []any{}
				}
				b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": frame.ID, "result": result})
				_, _ = c.Write(append(b, '\n'))
				if frame.Method == "session.hello" {
					close(hello)
				} else if frame.Method == "turn.ready" {
					f.ready <- frame
				}
			} else {
				if ch := f.pending[frame.ID]; ch != nil {
					delete(f.pending, frame.ID)
					ch <- frame
				}
			}
			f.mu.Unlock()
		}
	}()
	t.Cleanup(func() { cancel(); c.Close(); <-served; <-f.done; l.Close() })
	select {
	case <-hello:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var opened kit.OpenResult
	f.call(t, "session.open", kit.OpenRequest{Name: "lane@local", Groups: []string{}, ResumeSessionID: resume, Open: kit.OpenOptions{Cwd: t.TempDir(), PermissionMode: permission}}, &opened)
	if opened.SessionID != "ses_native" {
		t.Fatal(opened)
	}
	return f
}
func (f *workerFixture) call(t *testing.T, method string, params any, out any) {
	t.Helper()
	f.mu.Lock()
	f.next++
	id := f.next
	ch := make(chan protocol.Frame, 1)
	f.pending[id] = ch
	b, err := protocol.RequestBytes(id, method, params)
	if err != nil {
		f.mu.Unlock()
		t.Fatal(err)
	}
	_, err = f.c.Write(b)
	f.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	select {
	case frame := <-ch:
		if frame.Error != nil {
			t.Fatalf("%s: %+v", method, frame.Error)
		}
		if out != nil {
			if e := json.Unmarshal(frame.Result, out); e != nil {
				t.Fatal(e)
			}
		}
	case <-f.ctx.Done():
		t.Fatalf("%s: %v", method, f.ctx.Err())
	}
}
func (f *workerFixture) start(t *testing.T, seq int, text string) {
	f.call(t, "turn.execute", protocol.ExecuteRequest{SessionID: "ses_native@local", RunID: fmt.Sprintf("g/%d", seq), Input: text}, nil)
}
func (f *workerFixture) wait(t *testing.T, seq int) kit.RunStatus {
	var result kit.RunStatus
	f.call(t, "turn.wait", kit.WaitRequest{SessionID: "ses_native@local", RunID: fmt.Sprintf("g/%d", seq)}, &result)
	return result
}
func fixtureDelivery() kit.DeliveryRequest {
	return kit.DeliveryRequest{MessageID: "delivery", From: kit.DeliverySource{SessionID: "sender@local", Product: "claude", Groups: []string{}}, Body: "marker"}
}
func TestLegacyWorkerActiveDeliveryDefersBeforeNativeWrite(t *testing.T) {
	f := newWorkerFixture(t)
	f.start(t, 1, "hold")
	receipt, err := f.p.Deliver(context.Background(), fixtureDelivery(), nil)
	var notRunning *kit.ProtocolError
	if !errors.As(err, &notRunning) || notRunning.Code != -32004 || receipt.Disposition != "" {
		t.Fatalf("delivery = %+v, %v", receipt, err)
	}
	f.call(t, "turn.interrupt", map[string]any{"session_id": "ses_native@local"}, nil)
	result := f.wait(t, 1)
	if result.Result == nil || result.Result.Outcome != "interrupted" || result.Result.NativeStopReason != "MessageAbortedError" {
		t.Fatalf("result=%+v", result)
	}
	f.start(t, 2, "healthy")
	next := f.wait(t, 2)
	if next.Result == nil || next.Result.Result != "answer:healthy" {
		t.Fatalf("next=%+v", next)
	}
}

func TestLegacyWorkerSeedWrittenAndRetainedCursor(t *testing.T) {
	f := newWorkerFixture(t)
	d := fixtureDelivery()
	d.RunID = "g/1"
	var receipt kit.DeliveryReceipt
	f.call(t, "message.deliver", d, &receipt)
	if receipt.Disposition != "written" {
		t.Fatal(receipt)
	}
	result := f.wait(t, 1)
	if result.Result == nil || !strings.Contains(result.Result.Result, "marker") {
		t.Fatalf("seed=%+v", result)
	}
	var status kit.RunStatus
	f.call(t, "turn.status", kit.ReadRequest{SessionID: "ses_native@local", RunID: "g/1"}, &status)
	if status.Result == nil || status.Result.Result != result.Result.Result {
		t.Fatal("cursor consumed by wait")
	}
	f.call(t, "turn.ack", kit.RunRef{SessionID: "ses_native@local", RunID: "g/1"}, nil)
	f.start(t, 2, "next")
	if next := f.wait(t, 2); next.Result == nil || next.Result.Result != "answer:next" {
		t.Fatalf("next=%+v", next)
	}
}
func TestLegacyWorkerCancelledSummaryIsNotUserCompletion(t *testing.T) {
	f := newWorkerFixture(t)
	f.start(t, 1, "hold-summary")
	f.call(t, "turn.interrupt", map[string]any{"session_id": "ses_native@local"}, nil)
	r := f.wait(t, 1)
	if r.Result == nil || r.Result.Outcome != "interrupted" || r.Result.NativeStopReason != "" || r.Result.Result != "" {
		t.Fatalf("summary became terminal: %+v", r)
	}
}

type reportHeldProduct struct {
	*Wrapper
	entered, release chan struct{}
}

func (p *reportHeldProduct) Run(ctx context.Context, r *kit.Run, input kit.RunInput) (kit.TurnResult, error) {
	return p.executeRun(ctx, r, input, func(v kit.DeliveryReceipt, e error) error {
		close(p.entered)
		select {
		case <-p.release:
		case <-ctx.Done():
			return ctx.Err()
		}
		return r.ReportDelivery(v, e)
	})
}
func TestLegacyWorkerTerminalWhileSeedReportHeldAndBusLoss(t *testing.T) {
	for _, lost := range []bool{false, true} {
		t.Run(fmt.Sprint(lost), func(t *testing.T) {
			held := &reportHeldProduct{entered: make(chan struct{}), release: make(chan struct{})}
			var once sync.Once
			release := func() { once.Do(func() { close(held.release) }) }
			defer release()
			f := newWorkerProductFixture(t, func(p *Wrapper) kit.WorkerCallbacks { held.Wrapper = p; return held })
			d := fixtureDelivery()
			d.RunID = "g/1"
			f.mu.Lock()
			f.next++
			id := f.next
			response := make(chan protocol.Frame, 1)
			f.pending[id] = response
			b, err := protocol.RequestBytes(id, "message.deliver", d)
			if err != nil {
				f.mu.Unlock()
				t.Fatal(err)
			}
			_, err = f.c.Write(b)
			f.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			select {
			case <-held.entered:
			case <-f.ctx.Done():
				t.Fatal(f.ctx.Err())
			}
			f.p.mu.Lock()
			run := f.p.active
			f.p.mu.Unlock()
			<-run.original.done
			if run.original.err != nil {
				t.Fatal(run.original.err)
			}
			select {
			case <-run.run.Done():
				t.Fatal("shared Run retired while report owned")
			default:
			}
			if lost {
				f.c.Close()
				select {
				case <-f.worker.Closed():
				case <-f.ctx.Done():
					t.Fatal("bus loss did not join held report")
				}
				return
			}
			release()
			select {
			case r := <-response:
				if r.Error != nil {
					t.Fatal(r.Error)
				}
			case <-f.ctx.Done():
				t.Fatal(f.ctx.Err())
			}
			if r := f.wait(t, 1); r.Result == nil || r.Result.Outcome != "completed" {
				t.Fatalf("lost terminal=%+v", r)
			}
		})
	}
}
func TestLegacyResidentToolUsesNativeChildAncestry(t *testing.T) {
	f := newWorkerFixture(t)
	c, err := net.Dial("unix", f.p.endpoint.Path)
	if err != nil {
		t.Fatal(err)
	}
	// Close the product before this initialized resident: unexpected resident EOF
	// intentionally retires its owner, while test cleanup must remain joined.
	t.Cleanup(func() { f.c.Close(); c.Close() })
	r := bufio.NewReader(c)
	send := func(id int, method string, params any) map[string]json.RawMessage {
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
		if _, e := c.Write(append(b, '\n')); e != nil {
			t.Fatal(e)
		}
		line, e := r.ReadBytes('\n')
		if e != nil {
			t.Fatal(e)
		}
		var out map[string]json.RawMessage
		if e = json.Unmarshal(line, &out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	send(1, "initialize", map[string]any{"protocolVersion": "2024-11-05", "capabilities": map[string]any{}, "clientInfo": map[string]string{"name": "native", "version": "1"}})
	for i, id := range []string{"ses_child", "ses_other", ""} {
		result := send(i+2, "tools/call", map[string]any{"name": "sessionbus", "arguments": map[string]any{"action": "list", "arguments": map[string]any{}}, "_meta": map[string]any{"sessionbus.opencode": map[string]string{"session_id": id, "message_id": "msg_native_tool"}}})
		if i == 0 {
			if strings.Contains(string(result["result"]), `"isError":true`) || len(result["error"]) > 0 {
				t.Fatalf("child rejected: %s", result)
			}
		} else if !strings.Contains(string(result["result"]), `"isError":true`) && len(result["error"]) == 0 {
			t.Fatalf("unrelated/missing identity accepted: %s", result)
		}
	}
}

func TestLegacyWorkerEventLossJoinsHeldRunAndOwnedChild(t *testing.T) {
	for _, route := range []string{"/fixture/end-events", "/fixture/exit"} {
		t.Run(route, func(t *testing.T) {
			f := newWorkerFixture(t)
			f.start(t, 1, "hold-event-loss")
			if _, err := f.p.client.call(f.ctx, "GET", "/fixture/started", nil, 200); err != nil {
				t.Fatal(err)
			}
			f.p.mu.Lock()
			run := f.p.run
			childDone := f.p.childDone
			f.p.mu.Unlock()
			if run == nil {
				t.Fatal("no owned Run after native request started")
			}
			// Owner cancellation may race the fixture control response; its bytes are
			// not the assertion. Join the actual Run, daemon EOF and native child.
			_, _ = f.p.client.call(f.ctx, "POST", route, nil, 200)
			for name, done := range map[string]<-chan struct{}{"run": run.Done(), "bus": f.done, "child": childDone} {
				select {
				case <-done:
				case <-f.ctx.Done():
					t.Fatalf("%s did not settle after owner loss", name)
				}
			}
		})
	}
}

func TestLegacyWorkerRejectsNativePermissionAndQuestionWithoutGrant(t *testing.T) {
	for _, input := range []string{"hold-permission", "hold-question"} {
		t.Run(input, func(t *testing.T) {
			f := newWorkerFixture(t)
			f.start(t, 1, input)
			result := f.wait(t, 1)
			if result.Result == nil || result.Result.Outcome != "completed" {
				t.Fatalf("native execution not settled: %+v", result)
			}
			raw, err := f.p.client.call(f.ctx, "GET", "/fixture/state", nil, 200)
			if err != nil {
				t.Fatal(err)
			}
			var state struct {
				Rejections int
				Permission any
			}
			if json.Unmarshal(raw, &state) != nil || state.Rejections != 1 || state.Permission != nil {
				t.Fatalf("native rejection/default policy: %s", raw)
			}
		})
	}
}

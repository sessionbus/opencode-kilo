// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"strings"
	"testing"
)

func activePhase(t *testing.T, f *workerFixture) (*laneRun, nativeInputRequest) {
	t.Helper()
	if _, err := f.p.client.call(f.ctx, "GET", "/fixture/started", nil, 200); err != nil {
		t.Fatal(err)
	}
	f.p.mu.Lock()
	run := f.p.active
	id := run.phase.initial
	f.p.mu.Unlock()
	return run, nativeInputRequest{Operation: "bind", SessionID: f.p.id, MessageID: id, Created: 10}
}
func bindPhase(t *testing.T, f *workerFixture, bind nativeInputRequest) nativeInputRequest {
	t.Helper()
	raw, err := f.p.nativeInput(f.ctx, bind)
	var reply struct {
		Token string `json:"token"`
	}
	if err != nil || json.Unmarshal(raw, &reply) != nil || reply.Token != bind.MessageID {
		t.Fatalf("binding=%s/%v", raw, err)
	}
	bind.Operation, bind.Token, bind.After = "step", reply.Token, "prt_authored_"+bind.MessageID+"_text"
	return bind
}
func deliverRun(t *testing.T, f *workerFixture, run *laneRun, body string) {
	t.Helper()
	message := fixtureDelivery()
	message.MessageID, message.Body = "message_"+body, body
	receipt, err := f.p.Deliver(f.ctx, message, run.run)
	if err != nil || receipt.Disposition != "queued_for_next_turn" {
		t.Fatalf("admission=%+v/%v", receipt, err)
	}
}
func fixtureCall(t *testing.T, f *workerFixture, path string) []byte {
	t.Helper()
	raw, err := f.p.client.call(f.ctx, "GET", path, nil, 200)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
func TestNativeInputBusyStepPersistsFIFOWithoutEndingRun(t *testing.T) {
	for _, kind := range []nativeKind{openCodeNative, kiloNative} {
		t.Run(kind.name(), func(t *testing.T) {
			f := newWorkerKindFixture(t, kind, nil)
			f.start(t, 1, "hold-busy")
			run, bind := activePhase(t, f)
			step := bindPhase(t, f, bind)
			deliverRun(t, f, run, "first")
			deliverRun(t, f, run, "second")
			raw, err := f.p.nativeInput(f.ctx, step)
			var reply struct {
				Parts []nativeTextPart `json:"parts"`
			}
			if err != nil || json.Unmarshal(raw, &reply) != nil || len(reply.Parts) != 1 {
				t.Fatalf("step=%s/%v", raw, err)
			}
			if !strings.Contains(reply.Parts[0].Text, "first") || strings.Index(reply.Parts[0].Text, "first") >= strings.Index(reply.Parts[0].Text, "second") {
				t.Fatal("lost FIFO", reply)
			}
			f.p.mu.Lock()
			if f.p.active != run || run.bytes != 0 || !run.admission {
				t.Error("step ended Run or retained ownership")
			}
			f.p.mu.Unlock()
			select {
			case <-run.run.Done():
				t.Fatal("model-step handoff invented terminal")
			default:
			}
			for repeat := 0; repeat < 2; repeat++ {
				raw, err = f.p.nativeInput(f.ctx, step)
				if err != nil || string(raw) != `{"parts":[]}` {
					t.Fatal("repeat handoff", string(raw), err)
				}
			}
			// The next hook can hold a stale part snapshot, including after prune.
			deliverRun(t, f, run, "third")
			if _, err = f.p.nativeInput(f.ctx, step); err != nil {
				t.Fatal(err)
			}
			var state struct {
				Messages     []withParts
				InputPatches int
			}
			if json.Unmarshal(fixtureCall(t, f, "/fixture/state"), &state) != nil || state.InputPatches != 2 || len(state.Messages[0].Parts) != 3 {
				t.Fatal("part not durably appended", state)
			}
			var authored struct{ Text string }
			_ = json.Unmarshal(state.Messages[0].Parts[0], &authored)
			if authored.Text != "hold-busy" {
				t.Fatal("authored text replaced", authored.Text)
			}
			var first, second nativeTextPart
			_ = json.Unmarshal(state.Messages[0].Parts[1], &first)
			_ = json.Unmarshal(state.Messages[0].Parts[2], &second)
			if first.ID >= second.ID || !strings.Contains(first.Text, "first") || !strings.Contains(second.Text, "third") {
				t.Fatal("reload reordered FIFO", first, second)
			}
			fixtureCall(t, f, "/fixture/release")
			result := f.wait(t, 1)
			if result.Result == nil || result.Result.Outcome != "completed" {
				t.Fatal(result)
			}
		})
	}
}
func TestNativeInputExactPhaseAndRootGuardBeforeFIFO(t *testing.T) {
	for _, kind := range []nativeKind{openCodeNative, kiloNative} {
		t.Run(kind.name(), func(t *testing.T) {
			f := newWorkerKindFixture(t, kind, nil)
			f.start(t, 1, "hold-busy")
			run, bind := activePhase(t, f)
			step := bindPhase(t, f, bind)
			deliverRun(t, f, run, "guarded")
			for _, invalid := range []nativeInputRequest{
				{Operation: "bind", SessionID: "ses_child", MessageID: bind.MessageID, Created: bind.Created},
				{Operation: "bind", SessionID: bind.SessionID, MessageID: "msg_injected", Created: bind.Created + 1},
				{Operation: "step", SessionID: bind.SessionID, MessageID: bind.MessageID, Created: bind.Created, Token: "old_run"},
				{Operation: "step", SessionID: bind.SessionID, MessageID: "msg_older", Created: bind.Created - 1, Token: step.Token},
				{Operation: "step", SessionID: "ses_child", MessageID: bind.MessageID, Created: bind.Created, Token: step.Token},
			} {
				raw, err := f.p.nativeInput(f.ctx, invalid)
				if err != nil || strings.Contains(string(raw), "prt_") {
					t.Fatal("forged binding", string(raw), err)
				}
			}
			f.p.mu.Lock()
			if len(run.queue) != 1 {
				t.Error("forgery touched FIFO")
			}
			f.p.mu.Unlock()
			cancelled, cancel := context.WithCancel(f.ctx)
			cancel()
			if _, err := f.p.nativeInput(cancelled, step); !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			if _, err := f.p.nativeInput(f.ctx, step); err != nil {
				t.Fatal(err)
			}
			fixtureCall(t, f, "/fixture/release")
			f.wait(t, 1)
			raw, err := f.p.nativeInput(f.ctx, step)
			if err != nil || string(raw) != `{"parts":[]}` {
				t.Fatal("retired Run token", string(raw), err)
			}
		})
	}
}
func TestNativeInputFinalCompletionRecoversFIFOInSameRun(t *testing.T) {
	for _, kind := range []nativeKind{openCodeNative, kiloNative} {
		t.Run(kind.name(), func(t *testing.T) {
			f := newWorkerKindFixture(t, kind, nil)
			f.start(t, 1, "hold-busy")
			run, bind := activePhase(t, f)
			old := bindPhase(t, f, bind)
			if _, err := f.p.nativeInput(f.ctx, old); err != nil {
				t.Fatal(err)
			}
			deliverRun(t, f, run, "SUCCESSOR_HOLD")
			fixtureCall(t, f, "/fixture/release")
			fixtureCall(t, f, "/fixture/successor-started")
			f.p.mu.Lock()
			next := run.phase
			if next.initial == bind.MessageID || next.original == nil || f.p.active != run {
				t.Error("successor did not stay in exact Run")
			}
			f.p.mu.Unlock()
			select {
			case <-run.run.Done():
				t.Fatal("earlier result while successor active")
			default:
			}
			raw, err := f.p.nativeInput(f.ctx, old)
			if err != nil || string(raw) != `{"parts":[]}` {
				t.Fatal("old phase token rebound", string(raw), err)
			}
			f.call(t, "turn.interrupt", map[string]any{"session_id": "ses_native@local"}, nil)
			result := f.wait(t, 1)
			if result.Result == nil || result.Result.Outcome != "interrupted" || !strings.Contains(result.Result.Result, "SUCCESSOR_HOLD") || !strings.Contains(result.Result.Result, "answer:hold-busy") {
				t.Fatalf("wrong last-phase result %+v", result.Result)
			}
			var state struct{ Aborts, PhaseStarts int }
			_ = json.Unmarshal(fixtureCall(t, f, "/fixture/state"), &state)
			if state.Aborts != 1 || state.PhaseStarts != 2 {
				t.Fatal("interrupt did not target successor once", state)
			}
			if _, err = f.p.Deliver(f.ctx, fixtureDelivery(), run.run); err == nil {
				t.Fatal("enqueue after final close")
			}
		})
	}
}

func TestNativeInputHealthyCompletionWithoutHookPreservesRecoveryAndTools(t *testing.T) {
	for _, kind := range []nativeKind{openCodeNative, kiloNative} {
		for _, mode := range []string{"no-bind", "bound-no-step", "step-seen"} {
			t.Run(kind.name()+"/"+mode, func(t *testing.T) {
				f := newWorkerKindFixture(t, kind, nil)
				f.start(t, 1, "hold-busy")
				run, bind := activePhase(t, f)
				if mode != "no-bind" {
					step := bindPhase(t, f, bind)
					if mode == "step-seen" {
						if _, err := f.p.nativeInput(f.ctx, step); err != nil {
							t.Fatal(err)
						}
					}
				}
				marker := "RECOVERY_" + mode
				deliverRun(t, f, run, marker)
				f.p.mu.Lock()
				if len(run.queue) != 1 || run.bytes == 0 {
					t.Error("input was not retained before successor begin")
				}
				f.p.mu.Unlock()
				fixtureCall(t, f, "/fixture/release")
				result := f.wait(t, 1)
				if result.Result == nil || result.Result.Outcome != "completed" || !strings.Contains(result.Result.Result, marker) || !strings.Contains(result.Result.Result, "answer:hold-busy") {
					t.Fatalf("missing observation disabled healthy recovery: %+v", result)
				}
				if f.p.ctx.Err() != nil || !f.p.endpoint.live() {
					t.Fatal("healthy recovery retired owner or resident tools")
				}
				meta, _ := json.Marshal(map[string]any{"sessionbus." + kind.name(): map[string]string{"session_id": f.p.id, "message_id": "msg_tool_after_recovery"}})
				owner := &laneToolOwner{endpoint: f.p.endpoint}
				if reply, err := owner.ActionWithMeta(f.ctx, "list", json.RawMessage(`{}`), meta); err != nil || !strings.Contains(string(reply), "sessions") {
					t.Fatal("public tool could not use retained owner", string(reply), err)
				}
				f.start(t, 2, "AFTER_RECOVERY")
				if next := f.wait(t, 2); next.Result == nil || next.Result.Outcome != "completed" {
					t.Fatal("owner not reusable", next)
				}
				var state struct{ PhaseStarts int }
				_ = json.Unmarshal(fixtureCall(t, f, "/fixture/state"), &state)
				if state.PhaseStarts != 3 {
					t.Fatal("duplicate/missing recovery operation", state)
				}
			})
		}
	}
}

func TestNativeInputNoHookSuccessorWaitsForItsOwnTerminal(t *testing.T) {
	for _, kind := range []nativeKind{openCodeNative, kiloNative} {
		t.Run(kind.name(), func(t *testing.T) {
			f := newWorkerKindFixture(t, kind, nil)
			f.start(t, 1, "hold-busy")
			run, _ := activePhase(t, f)
			deliverRun(t, f, run, "SUCCESSOR_HOLD")
			fixtureCall(t, f, "/fixture/release")
			fixtureCall(t, f, "/fixture/successor-started")
			select {
			case <-run.run.Done():
				t.Fatal("earlier native result returned while no-hook recovery runs")
			default:
			}
			f.p.mu.Lock()
			if len(run.queue) != 0 || run.bytes != 0 || f.p.ctx.Err() != nil {
				t.Error("successor did not transfer ownership exactly once")
			}
			f.p.mu.Unlock()
			fixtureCall(t, f, "/fixture/release")
			result := f.wait(t, 1)
			if result.Result == nil || result.Result.Outcome != "completed" || !strings.Contains(result.Result.Result, "SUCCESSOR_HOLD") {
				t.Fatal("wrong recovery terminal/result", result)
			}
		})
	}
}

func TestNativeInputInterruptAfterCompletionBeforeRecoveryKeepsRealTerminal(t *testing.T) {
	for _, kind := range []nativeKind{openCodeNative, kiloNative} {
		t.Run(kind.name(), func(t *testing.T) {
			f := newWorkerKindFixture(t, kind, nil)
			f.start(t, 1, "hold-final-empty")
			run, _ := activePhase(t, f)
			fixtureCall(t, f, "/fixture/release")
			fixtureCall(t, f, "/fixture/projection-pending")
			deliverRun(t, f, run, "CANCELLED_UNSENT_RECOVERY")
			f.call(t, "turn.interrupt", map[string]any{"session_id": "ses_native@local"}, nil)
			fixtureCall(t, f, "/fixture/projection-release")
			result := f.wait(t, 1)
			if result.Result == nil || result.Result.Outcome != "completed" || !strings.Contains(result.Result.Result, "answer:hold-final-empty") || strings.Contains(result.Result.Result, "CANCELLED_UNSENT_RECOVERY") {
				t.Fatal("fabricated interruption or consumed cancelled recovery", result)
			}
			f.p.mu.Lock()
			if len(run.queue) != 0 || run.bytes != 0 || run.admission {
				t.Error("cancelled pre-begin recovery retained admission or ownership")
			}
			f.p.mu.Unlock()
			var state struct{ PhaseStarts int }
			_ = json.Unmarshal(fixtureCall(t, f, "/fixture/state"), &state)
			if state.PhaseStarts != 1 {
				t.Fatal("unauthorized post-interrupt native wake", state)
			}
		})
	}
}

func TestNativeInputResidentPrivateDispatchPreservesPublicCatalog(t *testing.T) {
	f := newWorkerFixture(t)
	f.start(t, 1, "hold-busy")
	run, bind := activePhase(t, f)
	c, err := net.Dial("unix", f.p.endpoint.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	encoder, decoder := json.NewEncoder(c), json.NewDecoder(bufio.NewReader(c))
	id := 0
	send := func(method string, params any) map[string]json.RawMessage {
		id++
		if err := encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
			t.Fatal(err)
		}
		var reply map[string]json.RawMessage
		if decoder.Decode(&reply) != nil {
			t.Fatal("missing reply")
		}
		return reply
	}
	send("initialize", map[string]string{"protocolVersion": "2024-11-05"})
	owner := &laneToolOwner{endpoint: f.p.endpoint}
	for _, method := range []string{"unknown", "tools/call"} {
		_, handled, err := owner.PrivateRequest(f.ctx, method, json.RawMessage(`{}`))
		if handled || err != nil {
			t.Fatal("hidden public action", method)
		}
	}
	for _, params := range []string{`{"operation":"unknown"}`, `{"operation":"step","sessionID":"ses_native","messageID":"msg_any","created":null,"token":"wrong"}`} {
		reply := send("sessionbus/native-input", json.RawMessage(params))
		if len(reply["error"]) == 0 {
			t.Fatal("unknown/malformed accepted", reply)
		}
	}
	reply := send("sessionbus/native-input", bind)
	var token struct{ Token string }
	_ = json.Unmarshal(reply["result"], &token)
	if token.Token != bind.MessageID {
		t.Fatal("resident bind", reply)
	}
	deliverRun(t, f, run, "resident")
	bind.Operation, bind.Token, bind.After = "step", token.Token, "prt_authored"
	reply = send("sessionbus/native-input", bind)
	if !strings.Contains(string(reply["result"]), "resident") || len(reply["error"]) != 0 {
		t.Fatal("private raw result", reply)
	}
	fixtureCall(t, f, "/fixture/release")
	f.wait(t, 1)
}

func TestNativeInputCompletionAndAdmissionClosureBothSidesWakeOnce(t *testing.T) {
	for _, kind := range []nativeKind{openCodeNative, kiloNative} {
		t.Run(kind.name(), func(t *testing.T) {
			f := newWorkerKindFixture(t, kind, nil)
			f.start(t, 1, "hold-final-empty")
			run, bind := activePhase(t, f)
			step := bindPhase(t, f, bind)
			if _, err := f.p.nativeInput(f.ctx, step); err != nil {
				t.Fatal(err)
			}
			fixtureCall(t, f, "/fixture/release")
			fixtureCall(t, f, "/fixture/projection-pending")
			f.p.mu.Lock()
			if !run.phase.sealed || !run.admission {
				t.Error("did not force native-terminal/admission-open crossing")
			}
			f.p.mu.Unlock()
			deliverRun(t, f, run, "AFTER_NATIVE_TERMINAL_1")
			deliverRun(t, f, run, "AFTER_NATIVE_TERMINAL_2")
			fixtureCall(t, f, "/fixture/projection-release")
			first := f.wait(t, 1)
			if first.Result == nil || first.Result.Outcome != "completed" || !strings.Contains(first.Result.Result, "AFTER_NATIVE_TERMINAL_2") || strings.Index(first.Result.Result, "AFTER_NATIVE_TERMINAL_1") >= strings.Index(first.Result.Result, "AFTER_NATIVE_TERMINAL_2") {
				t.Fatalf("same-Run FIFO recovery %+v", first.Result)
			}
			if _, err := f.p.Deliver(f.ctx, fixtureDelivery(), run.run); err == nil {
				t.Fatal("late admission after atomic empty check")
			}
			message := fixtureDelivery()
			message.RunID = "g/2"
			message.Body = "AFTER_RUN_CLOSURE"
			var receipt struct{ Disposition string }
			f.call(t, "message.deliver", message, &receipt)
			second := f.wait(t, 2)
			if second.Result == nil || !strings.Contains(second.Result.Result, "AFTER_RUN_CLOSURE") || strings.Contains(second.Result.Result, "AFTER_NATIVE_TERMINAL_") {
				t.Fatalf("new idle wake stranded/duplicated %+v", second.Result)
			}
			var state struct{ PhaseStarts int }
			_ = json.Unmarshal(fixtureCall(t, f, "/fixture/state"), &state)
			if state.PhaseStarts != 3 {
				t.Fatal("extra native operation", state)
			}
		})
	}
}

func admissionFixture(t *testing.T, kind nativeKind, handler http.HandlerFunc) (*Wrapper, *laneRun, nativeInputRequest) {
	t.Helper()
	ctx, cancel := context.WithCancelCause(context.Background())
	server := httptest.NewServer(handler)
	phaseCtx, phaseCancel := context.WithCancel(ctx)
	bind := nativeInputRequest{Operation: "bind", SessionID: "ses_root", MessageID: "msg_initial", Created: 10}
	complete := make(chan struct{})
	close(complete)
	phase := &lanePhase{initial: bind.MessageID, ctx: phaseCtx, cancel: phaseCancel, bound: &bind, stepSeen: true, original: &httpOperation{done: complete}, started: make(chan struct{})}
	run := &laneRun{run: &kit.Run{}, initial: bind.MessageID, phase: phase, admission: true, changed: make(chan struct{})}
	p := &Wrapper{kind: kind, ctx: ctx, cancel: cancel, id: bind.SessionID, opened: true, active: run, client: newLaneHTTP(server.URL, "/native", "u", "p")}
	p.client.kind = kind
	t.Cleanup(func() { cancel(context.Canceled); phaseCancel(); server.Close() })
	bind.Operation, bind.Token, bind.After = "step", bind.MessageID, "prt_authored"
	return p, run, bind
}
func TestNativeInputPreflightRefusalAndAttemptedLossNeverReplay(t *testing.T) {
	for _, kind := range []nativeKind{openCodeNative, kiloNative} {
		t.Run(kind.name(), func(t *testing.T) {
			var patches atomic.Int32
			p, run, step := admissionFixture(t, kind, func(w http.ResponseWriter, r *http.Request) { patches.Add(1); http.Error(w, "response uncertain", 500) })
			if receipt, err := p.Deliver(p.ctx, fixtureDelivery(), run.run); err != nil || receipt.Disposition != "queued_for_next_turn" {
				t.Fatal(receipt, err)
			}
			for len(p.client.slots) < cap(p.client.slots) {
				p.client.slots <- struct{}{}
			}
			if _, err := p.nativeInput(p.ctx, step); err == nil {
				t.Fatal("failed HTTP preflight admitted input")
			}
			p.mu.Lock()
			if len(run.queue) != 1 {
				t.Error("preflight removed owned input")
			}
			p.mu.Unlock()
			for len(p.client.slots) > 0 {
				<-p.client.slots
			}
			if _, err := p.nativeInput(p.ctx, step); err == nil {
				t.Fatal("unconfirmed response accepted")
			}
			raw, err := p.nativeInput(p.ctx, step)
			if err != nil || string(raw) != `{"parts":[]}` || patches.Load() != 1 {
				t.Fatal("ambiguous input replayed", string(raw), err, patches.Load())
			}
			if next, err := p.successor(p.ctx, run, kit.TurnResult{Outcome: "completed"}); err != nil || next != nil {
				t.Fatal("attempted input went to idle fallback", next, err)
			}
		})
	}
}
func TestNativeInputEndCancelsAndJoinsAttemptedStep(t *testing.T) {
	entered := make(chan struct{})
	p, run, step := admissionFixture(t, openCodeNative, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(entered)
		<-r.Context().Done()
	})
	if _, err := p.Deliver(p.ctx, fixtureDelivery(), run.run); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := p.nativeInput(p.ctx, step); done <- err }()
	<-entered
	owner := &laneToolOwner{endpoint: &laneEndpoint{owner: p}, initialized: true}
	owner.End()
	if err := <-done; err == nil {
		t.Fatal("End allowed late response")
	}
	run.phase.hooks.Wait()
	if len(p.client.slots) != 0 || run.bytes != 0 || len(run.queue) != 0 {
		t.Fatal("End left attempted work/accounting")
	}
}
func TestKiloSuccessorObservedBlockerAndCancelDoNotPost(t *testing.T) {
	checked := make(chan struct{})
	release := make(chan struct{})
	var posts atomic.Int32
	p, run, _ := admissionFixture(t, kiloNative, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posts.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{})
			return
		}
		if r.URL.Path == "/question" {
			close(checked)
			<-release
			_ = json.NewEncoder(w).Encode([]map[string]string{{"sessionID": "ses_root"}})
			return
		}
		_ = json.NewEncoder(w).Encode([]any{})
	})
	run.queue = []*laneInput{{text: "never attempted"}}
	run.bytes = len(run.queue[0].text)
	ctx, cancel := context.WithCancel(p.ctx)
	defer cancel()
	defer close(release)
	done := make(chan error, 1)
	go func() { _, err := p.successor(ctx, run, kit.TurnResult{Outcome: "completed"}); done <- err }()
	<-checked
	p.mu.Lock()
	if len(run.queue) != 1 || run.bytes == 0 {
		t.Error("blocker consumed input")
	}
	p.mu.Unlock()
	p.ensureInterrupt(run)
	cancel()
	if err := <-done; err == nil {
		t.Fatal("cancelled snapshot accepted")
	}
	if posts.Load() != 0 {
		t.Fatal("blocker/cancel dismissed through successor")
	}
}

// The HTTP exchange closes its connection after reading the returned body.
// Observe Done only after that boundary to join the successor's blocker wait.
type successorWaitContext struct {
	context.Context
	returned *atomic.Bool
	waiting  chan struct{}
	once     sync.Once
}

func (c *successorWaitContext) Done() <-chan struct{} {
	if c.returned.Load() {
		c.once.Do(func() { close(c.waiting) })
	}
	return c.Context.Done()
}

type successorResponseConn struct {
	net.Conn
	closed func()
	once   sync.Once
}

func (c *successorResponseConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(c.closed)
	return err
}

func TestKiloSuccessorReturnedBlockerRetainsInputUntilEventOrCancel(t *testing.T) {
	for _, clear := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "clear"}[clear], func(t *testing.T) {
			var blocked, returned atomic.Bool
			blocked.Store(true)
			var posts atomic.Int32
			p, run, _ := admissionFixture(t, kiloNative, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					posts.Add(1)
					_ = json.NewEncoder(w).Encode(map[string]any{})
				} else if r.URL.Path == "/question" && blocked.Load() {
					_ = json.NewEncoder(w).Encode([]map[string]string{{"sessionID": "ses_root"}})
				} else {
					_ = json.NewEncoder(w).Encode([]any{})
				}
			})
			dial := p.client.dial
			var calls atomic.Int32
			p.client.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
				call := calls.Add(1)
				conn, err := dial(ctx, network, address)
				if err == nil && call == 2 {
					return &successorResponseConn{Conn: conn, closed: func() { returned.Store(true) }}, nil
				}
				return conn, err
			}
			run.queue = []*laneInput{{text: "never attempted"}}
			run.bytes = len(run.queue[0].text)
			base, cancel := context.WithCancel(p.ctx)
			defer cancel()
			ctx := &successorWaitContext{Context: base, returned: &returned, waiting: make(chan struct{})}
			done := make(chan error, 1)
			go func() {
				phase, err := p.successor(ctx, run, kit.TurnResult{Outcome: "completed"})
				if phase != nil {
					_, err = phase.original.wait()
					phase.cancel()
				}
				done <- err
			}()
			<-ctx.waiting
			p.mu.Lock()
			if posts.Load() != 0 || len(run.queue) != 1 || run.bytes != len("never attempted") || run.phase.original != nil {
				t.Error("returned blocker did not retain never-attempted ownership")
			}
			p.mu.Unlock()
			if clear {
				blocked.Store(false)
				if err := p.observe([]byte(`{"type":"question.replied","properties":{"sessionID":"ses_root","id":"que_root"}}`)); err != nil {
					t.Fatal(err)
				}
			} else {
				p.ensureInterrupt(run)
				cancel()
			}
			if err := <-done; clear && err != nil {
				t.Fatal(err)
			}
			if posts.Load() != map[bool]int32{false: 0, true: 1}[clear] || len(run.queue) != 0 || run.bytes != 0 {
				t.Fatal("blocker event/cancel stranded or duplicated ownership", posts.Load(), run.bytes)
			}
		})
	}
}

func TestKiloSuccessorObservedEventInvalidatesCleanSnapshotBeforeBegin(t *testing.T) {
	var posts, permissionQueries atomic.Int32
	var returned atomic.Bool
	p, run, _ := admissionFixture(t, kiloNative, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{})
		} else if r.URL.Path == "/permission" && permissionQueries.Add(1) == 2 {
			_ = json.NewEncoder(w).Encode([]map[string]string{{"sessionID": "ses_root"}})
		} else {
			_ = json.NewEncoder(w).Encode([]any{})
		}
	})
	dial := p.client.dial
	var calls atomic.Int32
	p.client.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		call := calls.Add(1)
		conn, err := dial(ctx, network, address)
		if err == nil && (call == 2 || call == 3) {
			return &successorResponseConn{Conn: conn, closed: func() {
				if call == 2 {
					// Both clean bodies have been read, but begin has not run.
					if err := p.observe([]byte(`{"type":"permission.replied","properties":{"sessionID":"ses_root","id":"per_root"}}`)); err != nil {
						t.Error(err)
					}
				} else {
					returned.Store(true)
				}
			}}, nil
		}
		return conn, err
	}
	run.queue = []*laneInput{{text: "never attempted"}}
	run.bytes = len(run.queue[0].text)
	base, cancel := context.WithCancel(p.ctx)
	defer cancel()
	ctx := &successorWaitContext{Context: base, returned: &returned, waiting: make(chan struct{})}
	done := make(chan error, 1)
	go func() { _, err := p.successor(ctx, run, kit.TurnResult{Outcome: "completed"}); done <- err }()
	<-ctx.waiting
	p.mu.Lock()
	if posts.Load() != 0 || calls.Load() != 3 || len(run.queue) != 1 || run.bytes != len("never attempted") || run.phase.original != nil {
		t.Error("observed event did not invalidate the clean snapshot before begin")
	}
	p.mu.Unlock()
	p.ensureInterrupt(run)
	cancel()
	<-done
	if posts.Load() != 0 || len(run.queue) != 0 || run.bytes != 0 {
		t.Fatal("cancel after an observed blocker started or retained work")
	}
}
func TestNativeSuccessorInterruptBeforeBeginNeverStartsWork(t *testing.T) {
	for _, kind := range []nativeKind{openCodeNative, kiloNative} {
		t.Run(kind.name(), func(t *testing.T) {
			var posts atomic.Int32
			p, run, _ := admissionFixture(t, kind, func(w http.ResponseWriter, r *http.Request) { posts.Add(1); _ = json.NewEncoder(w).Encode([]any{}) })
			run.queue = []*laneInput{{text: "never attempted"}}
			run.bytes = len(run.queue[0].text)
			p.ensureInterrupt(run)
			if phase, err := p.successor(p.ctx, run, kit.TurnResult{Outcome: "completed"}); err != nil || phase != nil || posts.Load() != 0 {
				t.Fatal("interrupt allowed successor", phase, err)
			}
		})
	}
}

// This deliberately documents a native limitation, not a blocker-preservation
// PASS: external same-root commands can create a question after our last clean
// check, and ordinary POST dismisses it, as in the released idle fallback.
func TestKiloSuccessorDocumentsExternalQuestionAfterFinalCheck(t *testing.T) {
	var question, dismissed atomic.Bool
	postReady, release := make(chan struct{}), make(chan struct{})
	p, run, _ := admissionFixture(t, kiloNative, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			dismissed.Store(question.Swap(false))
			_ = json.NewEncoder(w).Encode(map[string]any{})
			return
		}
		_ = json.NewEncoder(w).Encode([]any{})
	})
	run.queue = []*laneInput{{text: "queued recovery"}}
	run.bytes = len(run.queue[0].text)
	dial := p.client.dial
	var calls atomic.Int32
	p.client.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		if calls.Add(1) == 3 {
			close(postReady)
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return dial(ctx, network, address)
	}
	phase, err := p.successor(p.ctx, run, kit.TurnResult{Outcome: "completed"})
	if err != nil || phase == nil {
		t.Fatal(phase, err)
	}
	<-postReady
	question.Store(true)
	close(release)
	if _, err := phase.original.wait(); err != nil {
		t.Fatal(err)
	}
	if !dismissed.Load() || question.Load() {
		t.Fatal("fixture did not expose the native after-check residual")
	}
	phase.cancel()
}

func TestNativePartIDByteOrderingBounds(t *testing.T) {
	for _, floor := range []string{"prt_", "prt_!", "prt_imported~", "prt_fffffffffffexxxxxxxxxxxxxx", "prt_ffffffffffffzzzzzzzzzzzzzz", "prt_" + strings.Repeat("~", 219) + "!" + strings.Repeat("~", 32)} {
		one, err := orderedPartID(floor, bytes.NewReader(make([]byte, 16)))
		if err != nil || !validPartFloor(one) || one <= floor {
			t.Fatalf("ordered successor %q => %q: %v", floor, one, err)
		}
		two, err := orderedPartID(one, bytes.NewReader(make([]byte, 16)))
		if err != nil || two <= one {
			t.Fatalf("equal entropy wrapped ordering: %q => %q: %v", one, two, err)
		}
	}
	for _, floor := range []string{"bad", "prt_é", "prt_ space", "prt_\x7f", "prt_" + strings.Repeat("x", 253), "prt_" + strings.Repeat("~", 252)} {
		if _, err := orderedPartID(floor, bytes.NewReader(make([]byte, 16))); err == nil {
			t.Fatalf("accepted unsupported/exhausted bound %q", floor)
		}
	}
}

func TestNativePartOrderingUncertainSnapshotAndParentReplacement(t *testing.T) {
	for _, kind := range []nativeKind{openCodeNative, kiloNative} {
		t.Run(kind.name(), func(t *testing.T) {
			var persisted []nativeTextPart
			p, run, step := admissionFixture(t, kind, func(w http.ResponseWriter, r *http.Request) {
				var part nativeTextPart
				if json.NewDecoder(r.Body).Decode(&part) != nil {
					t.Error("bad part")
					return
				}
				persisted = append(persisted, part)
				if len(persisted) == 1 {
					http.Error(w, "persisted response lost", 500)
					return
				}
				_ = json.NewEncoder(w).Encode(part)
			})
			for n := 0; n < 3; n++ {
				message := fixtureDelivery()
				message.Body = []string{"FIRST", "SECOND", "THIRD"}[n]
				if _, err := p.Deliver(p.ctx, message, run.run); err != nil {
					t.Fatal(err)
				}
				_, err := p.nativeInput(p.ctx, step)
				if n == 0 && err == nil || n > 0 && err != nil {
					t.Fatal("unexpected patch outcome", n, err)
				}
			}
			if len(persisted) != 3 || persisted[0].ID <= step.After || persisted[1].ID <= persisted[0].ID || persisted[2].ID <= persisted[1].ID {
				t.Fatal("stale snapshot reordered parts", persisted)
			}
			p.mu.Lock()
			if len(run.queue) != 0 || run.bytes != 0 {
				t.Error("attempted ownership retained")
			}
			p.mu.Unlock()
			// Another native parent gets its own floor, not this parent's last ID.
			step.MessageID, step.Created, step.After = "msg_new_parent", 11, "prt_"
			if _, err := p.Deliver(p.ctx, fixtureDelivery(), run.run); err != nil {
				t.Fatal(err)
			}
			if _, err := p.nativeInput(p.ctx, step); err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(persisted[3].ID, "prt_000000000000") {
				t.Fatal("foreign parent floor inherited", persisted[3].ID)
			}
		})
	}
}

func TestNativePartInvalidBoundDoesNotTouchFIFO(t *testing.T) {
	for _, kind := range []nativeKind{openCodeNative, kiloNative} {
		t.Run(kind.name(), func(t *testing.T) {
			var patches atomic.Int64
			p, run, step := admissionFixture(t, kind, func(w http.ResponseWriter, r *http.Request) {
				patches.Add(1)
				var part nativeTextPart
				_ = json.NewDecoder(r.Body).Decode(&part)
				_ = json.NewEncoder(w).Encode(part)
			})
			if _, err := p.Deliver(p.ctx, fixtureDelivery(), run.run); err != nil {
				t.Fatal(err)
			}
			before := run.bytes
			for _, after := range []string{"prt_é", "prt_" + strings.Repeat("~", 252)} {
				step.After = after
				if _, err := p.nativeInput(p.ctx, step); err == nil {
					t.Fatal("invalid bound accepted")
				}
				p.mu.Lock()
				if len(run.queue) != 1 || run.bytes != before {
					t.Error("pre-handoff refusal changed ownership")
				}
				p.mu.Unlock()
			}
			if patches.Load() != 0 {
				t.Fatal("invalid bound attempted PATCH")
			}
			step.After = "prt_authored"
			if _, err := p.nativeInput(p.ctx, step); err != nil {
				t.Fatal(err)
			}
		})
	}
}

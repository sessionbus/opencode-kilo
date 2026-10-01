// SPDX-License-Identifier: MIT

package opencode

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/antst/sessionbus/bus/sdk/go/protocol"
	"github.com/sessionbus/opencode-kilo/wrappers/opencodefamily"
	"github.com/sessionbus/peer-common/host"
)

// declined answers native permission asks and forms in a lane: no human is
// present to approve or answer them. Native then fails only that tool call and
// the model continues.
const declined = "Declined: this Sessionbus lane runs without a human who could approve or answer it."

var (
	grantRule    = permissionRule{Action: "sessionbus", Resource: "*", Effect: "allow"}
	wildcardRule = permissionRule{Action: "*", Resource: "*", Effect: "allow"}
	laneRules    = []host.ArgumentRule{
		{Name: "--agent", TakesValue: true},
		{Name: "--hostname", TakesValue: true, ConflictField: "topology"},
		{Name: "--port", TakesValue: true, ConflictField: "topology"},
		{Name: "--stdio", ConflictField: "topology"},
		{Name: "--service", ConflictField: "topology"},
		{Name: "--standalone", ConflictField: "topology"},
		{Name: "--server", TakesValue: true, ConflictField: "topology"},
		{Name: "-m", TakesValue: true, ConflictField: "model"},
		{Name: "--model", TakesValue: true, ConflictField: "model"},
		{Name: "-c", ConflictField: "session_id"},
		{Name: "--continue", ConflictField: "session_id"},
		{Name: "-s", TakesValue: true, ConflictField: "session_id"},
		{Name: "--session", TakesValue: true, ConflictField: "session_id"},
		{Name: "--fork", ConflictField: "session_id"},
		{Name: "--prompt", TakesValue: true, ConflictField: "arguments"},
		{Name: "--auto", ConflictField: "permission_mode"},
	}
)

type permissionRule struct {
	Action   string `json:"action"`
	Resource string `json:"resource"`
	Effect   string `json:"effect"`
}

type modelRef struct {
	ID         string `json:"id"`
	ProviderID string `json:"providerID"`
}

type nativeSession struct {
	ID          string           `json:"id"`
	ParentID    string           `json:"parentID"`
	Permissions []permissionRule `json:"permissions"`
}

// laneHost supplies the native server one lane drives.
type laneHost interface {
	// start returns a client for the native server. Losing that server ends the
	// lane's event stream, which ends the lane.
	start(ctx context.Context, cwd, tools string) (*nativeClient, error)
	// bind lets the session's Sessionbus tool reach the lane's endpoint before
	// each Run.
	bind(ctx context.Context, client *nativeClient, session, tools string) error
	// close releases what start acquired; it never stops a server the lane
	// does not own.
	close() error
}

// Lane is one daemon-owned OpenCode v2 lane: one native session driven through
// the native HTTP API, with its Sessionbus tool answered by the worker's own
// bus identity.
type Lane struct {
	socket   string
	host     laneHost
	caller   *kit.Caller
	shutdown func()
	ids      messageIDs

	mu        sync.Mutex
	ctx       context.Context
	cancel    context.CancelCauseFunc
	client    *nativeClient
	tools     string
	closeTool func() error
	session   string
	opened    bool
	closing   bool
	active    *laneRun
	position  int
	connected chan struct{}
	lineage   map[string]bool // native session -> whether it is the lane's session or a descendant
	workers   sync.WaitGroup
	closeOnce sync.Once
	closeErr  error
}

func newLane(socket string, h laneHost) *Lane {
	return &Lane{socket: socket, host: h, lineage: map[string]bool{}, connected: make(chan struct{})}
}

func (l *Lane) SetCaller(c *kit.Caller) { l.caller = c }
func (l *Lane) SetShutdown(f func())    { l.shutdown = f }

func (l *Lane) Hello(context.Context) (kit.HelloDescription, error) {
	return kit.HelloDescription{Product: opencodefamily.Product, SupportsMessageRun: true, SupportedOpenFields: []string{"cwd", "permission_mode", "model", "arguments"}, ExtraArguments: []kit.ExtraArgument{{Name: "--agent", Description: "Native agent", TakesValue: true}}}, nil
}

type laneOptions struct {
	agent  string
	model  *modelRef
	bypass bool
}

func parseLaneOptions(open kit.OpenOptions) (laneOptions, error) {
	var options laneOptions
	switch open.PermissionMode {
	case "", "default":
	case "bypassPermissions":
		options.bypass = true
	default:
		return options, fmt.Errorf("unsupported value permission_mode=%s", open.PermissionMode)
	}
	if open.ReasoningEffort != "" {
		return options, errors.New("OpenCode does not support reasoning_effort")
	}
	validated, err := host.BuildArguments(open.Arguments, laneRules)
	if err != nil {
		return options, err
	}
	for index := 0; index < len(validated); index++ {
		_, value, attached := strings.Cut(validated[index], "=")
		if !attached {
			index++
			value = validated[index]
		}
		if options.agent != "" || !nativeValue(value) {
			return options, errors.New("--agent accepts one value")
		}
		options.agent = value
	}
	if open.Model != "" {
		provider, name, found := strings.Cut(open.Model, "/")
		if !found || !nativeValue(provider) || !nativeValue(name) {
			return options, errors.New("model requires one provider/model value")
		}
		options.model = &modelRef{ID: name, ProviderID: provider}
	}
	return options, nil
}

func nativeValue(value string) bool {
	return value != "" && strings.TrimSpace(value) == value && len(value) <= 256 && !strings.ContainsAny(value, "\x00\r\n")
}

// sessionRules keeps the session's own rules, applies an explicit bypass as
// the native wildcard allow, and always ends with the Sessionbus-only grant.
func sessionRules(existing []permissionRule, bypass bool) []permissionRule {
	rules := slices.Clone(existing)
	for len(rules) > 0 && rules[len(rules)-1] == grantRule {
		rules = rules[:len(rules)-1]
	}
	if bypass && (len(rules) == 0 || rules[len(rules)-1] != wildcardRule) {
		rules = append(rules, wildcardRule)
	}
	return append(rules, grantRule)
}

func (l *Lane) Open(ctx context.Context, request kit.OpenRequest) (result kit.OpenResult, err error) {
	if l.caller == nil {
		return result, errors.New("OpenCode lane Caller unavailable")
	}
	options, err := parseLaneOptions(request.Open)
	if err != nil {
		return result, err
	}
	at := strings.LastIndexByte(request.Name, '@')
	if at < 1 {
		return result, errors.New("invalid lane name")
	}
	title := request.Name[:at]
	cwd, err := filepath.Abs(cmpOr(request.Open.Cwd, "."))
	if err == nil {
		cwd, err = filepath.EvalSymlinks(cwd)
	}
	if err != nil {
		return result, err
	}
	l.mu.Lock()
	if l.ctx != nil || l.closing {
		l.mu.Unlock()
		return result, errors.New("OpenCode lane owner already used")
	}
	l.ctx, l.cancel = context.WithCancelCause(context.WithoutCancel(ctx))
	l.mu.Unlock()
	defer func() {
		if err != nil {
			err = errors.Join(err, l.Close(context.WithoutCancel(ctx), kit.SessionCloseRequest{}))
		}
	}()
	startup, stop := context.WithCancelCause(l.ctx)
	defer stop(nil)
	defer context.AfterFunc(ctx, func() { stop(ctx.Err()) })()
	key := make([]byte, 12)
	if _, err = rand.Read(key); err != nil {
		return result, err
	}
	tools, closeTools, err := opencodefamily.ListenLaneTools(l, l.socket, hex.EncodeToString(key), "opencode", "OpenCode")
	if err != nil {
		return result, err
	}
	l.mu.Lock()
	l.tools, l.closeTool = tools, closeTools
	l.mu.Unlock()
	client, err := l.host.start(startup, cwd, tools)
	if err != nil {
		return result, err
	}
	l.mu.Lock()
	l.client = client
	l.mu.Unlock()
	l.workers.Add(1)
	go func() {
		defer l.workers.Done()
		err := client.events(l.ctx, l.observe)
		l.fail(fmt.Errorf("OpenCode event stream: %w", err))
	}()
	// The event stream precedes every native request of this lane.
	select {
	case <-l.connected:
	case <-startup.Done():
		return result, context.Cause(startup)
	}
	session, err := l.openSession(startup, client, request.ResumeSessionID, title, cwd, options)
	if err != nil {
		return result, err
	}
	// A lane is ready only once its session's Sessionbus tool is bound: a
	// missing or unloaded native plugin refuses Open instead of failing the
	// first Run. Each Run binds again, as a location reload or service
	// restart drops the binding.
	if err = l.host.bind(startup, client, session, tools); err != nil {
		return result, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if ctx.Err() != nil || l.ctx.Err() != nil || l.closing {
		return result, errors.Join(errors.New("OpenCode lane ended before Open adoption"), ctx.Err(), context.Cause(l.ctx))
	}
	l.session, l.opened = session, true
	l.lineage[session] = true
	l.workers.Add(1)
	go l.monitor()
	return kit.OpenResult{SessionID: session}, nil
}

func cmpOr(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func (l *Lane) openSession(ctx context.Context, client *nativeClient, resume, title, cwd string, options laneOptions) (string, error) {
	if resume == "" {
		body := map[string]any{"title": title, "location": map[string]string{"directory": cwd}, "permissions": sessionRules(nil, options.bypass)}
		if options.model != nil {
			body["model"] = options.model
		}
		if options.agent != "" {
			body["agent"] = options.agent
		}
		var created struct {
			Data nativeSession `json:"data"`
		}
		if err := client.call(ctx, "POST", "/api/session", body, &created); err != nil {
			return "", err
		}
		if !strings.HasPrefix(created.Data.ID, "ses_") {
			return "", errors.New("OpenCode did not confirm the created session")
		}
		return created.Data.ID, nil
	}
	path := "/api/session/" + url.PathEscape(resume)
	var got struct {
		Data nativeSession `json:"data"`
	}
	if err := client.call(ctx, "GET", path, nil, &got); err != nil {
		return "", err
	}
	if got.Data.ID != resume || got.Data.ParentID != "" {
		return "", errors.New("OpenCode lane resumes only its own top-level session")
	}
	if err := client.call(ctx, "PATCH", path, map[string]any{"title": title, "permissions": sessionRules(got.Data.Permissions, options.bypass)}, nil); err != nil {
		return "", err
	}
	if options.model != nil {
		if err := client.call(ctx, "POST", path+"/model", map[string]any{"model": options.model}, nil); err != nil {
			return "", err
		}
	}
	if options.agent != "" {
		if err := client.call(ctx, "POST", path+"/agent", map[string]string{"agent": options.agent}, nil); err != nil {
			return "", err
		}
	}
	return resume, nil
}

func (l *Lane) fail(err error) {
	l.mu.Lock()
	cancel := l.cancel
	l.mu.Unlock()
	if cancel != nil {
		cancel(err)
	}
}

// monitor retires an adopted lane after unexpected failure with an ordinary
// close of its own lane, once its Run has settled; a close already in progress
// owns retirement.
func (l *Lane) monitor() {
	defer l.workers.Done()
	<-l.ctx.Done()
	l.mu.Lock()
	active, closing, shutdown, caller, id := l.active, l.closing, l.shutdown, l.caller, l.session
	l.mu.Unlock()
	if active != nil {
		<-active.run.Done()
	}
	if closing || shutdown == nil {
		return
	}
	go func() {
		err := caller.Close(context.Background(), kit.SessionCloseRequest{SessionID: id})
		var refused *kit.ProtocolError
		if errors.As(err, &refused) && refused.Code == protocol.Busy {
			return
		}
		l.mu.Lock()
		closing := l.closing
		l.mu.Unlock()
		if !closing {
			shutdown()
		}
	}()
}

// Close ends this lane's own use of native. The Worker interrupts and settles
// an active Run before calling it.
func (l *Lane) Close(context.Context, kit.SessionCloseRequest) error {
	l.closeOnce.Do(func() {
		l.mu.Lock()
		l.closing = true
		cancel, closeTool := l.cancel, l.closeTool
		l.mu.Unlock()
		if cancel != nil {
			cancel(errors.New("OpenCode lane closing"))
		}
		l.closeErr = l.host.close()
		if closeTool != nil {
			l.closeErr = errors.Join(l.closeErr, closeTool())
		}
		l.workers.Wait()
	})
	return l.closeErr
}

// ToolEnded is routine in v2: a location unload disposes the plugin and its
// rebuilt instance connects again. Native server loss is watched separately.
func (l *Lane) ToolEnded() {}

// ToolAction answers a tool call of the lane's session or its descendants
// through the lane's bus identity.
func (l *Lane) ToolAction(ctx context.Context, sessionID, _, action string, args json.RawMessage) (json.RawMessage, error) {
	l.mu.Lock()
	ready, caller := l.opened && !l.closing, l.caller
	l.mu.Unlock()
	if !ready || caller == nil {
		return nil, errors.New("OpenCode lane not adopted")
	}
	belongs, err := l.belongs(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if !belongs {
		return nil, errors.New("OpenCode tool call is outside the lane's sessions")
	}
	return caller.Action(ctx, action, args)
}

// belongs reports whether a native session is the lane's session or one of
// its descendants, by native parentID. Both answers are remembered, as native's
// own headless runner does; a failed lookup is not.
func (l *Lane) belongs(ctx context.Context, id string) (bool, error) {
	var walked []string
	answer := false
	for depth := 0; depth < 32 && id != ""; depth++ {
		l.mu.Lock()
		known, cached := l.lineage[id]
		client, life := l.client, l.ctx
		l.mu.Unlock()
		if cached {
			answer = known
			break
		}
		if client == nil || life == nil {
			return false, errors.New("OpenCode lane unavailable")
		}
		combined, cancel := context.WithCancel(ctx)
		stop := context.AfterFunc(life, cancel)
		var got struct {
			Data nativeSession `json:"data"`
		}
		err := client.call(combined, "GET", "/api/session/"+url.PathEscape(id), nil, &got)
		stop()
		cancel()
		if err != nil {
			return false, err
		}
		walked = append(walked, id)
		id = got.Data.ParentID
	}
	l.mu.Lock()
	for _, seen := range walked {
		l.lineage[seen] = answer
	}
	l.mu.Unlock()
	return answer, nil
}

// Deliver steers a message into the active Run's native execution.
func (l *Lane) Deliver(ctx context.Context, request kit.DeliveryRequest, run *kit.Run) (kit.DeliveryReceipt, error) {
	text, err := host.RenderNativeMessage(request)
	if err != nil {
		return kit.DeliveryReceipt{}, err
	}
	if len(text) > maxNativeInput {
		return kit.DeliveryReceipt{Disposition: "rejected", Reason: "message_too_large"}, nil
	}
	id, err := l.ids.next()
	if err != nil {
		return kit.DeliveryReceipt{}, err
	}
	l.mu.Lock()
	r := l.active
	if r == nil || r.run != run || r.final || r.cancelled || l.ctx.Err() != nil {
		l.mu.Unlock()
		return kit.DeliveryReceipt{}, host.NotRunning()
	}
	r.prompts[id] = promptInflight
	client, path, life, session := l.client, l.promptPath(), l.ctx, l.session
	l.mu.Unlock()
	combined, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(life, cancel)
	err = client.call(combined, "POST", path, map[string]string{"id": id, "text": text, "delivery": "steer"}, nil)
	stop()
	cancel()
	admitted := l.resolve(r, id, err)
	// Answered only after its cancelled Run ended: whatever the answer, native
	// may hold it, so it is withdrawn like the Run's other undelivered steers.
	// Before the terminal, the Run's own withdrawal covers it.
	l.mu.Lock()
	late := r.cancelled && r.final
	l.mu.Unlock()
	if late && l.withdraw(client, session, id) != nil {
		return kit.DeliveryReceipt{}, &kit.ProtocolError{Code: protocol.Internal, Message: "internal", Data: json.RawMessage(`"OpenCode input not withdrawn after its Run was cancelled; it may run with the next task"`)}
	}
	var refused *nativeStatus
	switch {
	case admitted:
		return kit.DeliveryReceipt{Disposition: "injected"}, nil
	case errors.As(err, &refused) && refused.refused():
		return kit.DeliveryReceipt{Disposition: "rejected", Reason: refused.Error()}, nil
	default:
		return kit.DeliveryReceipt{}, &kit.ProtocolError{Code: protocol.Internal, Message: "internal", Data: json.RawMessage(`"OpenCode prompt outcome unknown"`)}
	}
}

func (l *Lane) promptPath() string { return "/api/session/" + url.PathEscape(l.session) + "/prompt" }

// Interrupt asks native to interrupt the active Run's execution and marks the
// Run cancelled: it takes no further input, and before it ends it withdraws
// the steers native has not delivered (Run).
func (l *Lane) Interrupt(ctx context.Context, run *kit.Run) error {
	l.mu.Lock()
	r, client, session := l.active, l.client, l.session
	if r == nil || r.run != run {
		l.mu.Unlock()
		return nil
	}
	r.cancelled = true
	l.mu.Unlock()
	var answer struct {
		Interrupted bool `json:"interrupted"`
	}
	err := client.call(ctx, "POST", "/api/session/"+url.PathEscape(session)+"/interrupt?resume=false", struct{}{}, &answer)
	if err != nil {
		// A Run native already ended stays cancelled: its withdrawal is due.
		l.mu.Lock()
		if !r.final {
			r.cancelled = false
		}
		l.mu.Unlock()
	}
	return err
}

// withdraw cancels one inbox input; native answers an already delivered or
// unknown item as a no-op.
func (l *Lane) withdraw(client *nativeClient, session, id string) error {
	l.mu.Lock()
	life := l.ctx
	l.mu.Unlock()
	return client.call(life, "DELETE", "/api/session/"+url.PathEscape(session)+"/inbox/"+url.PathEscape(id), nil, nil)
}

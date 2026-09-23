// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/sessionbus/peer-common/host"
)

const (
	opencodeInteractiveLaunchEnv = "SESSIONBUS_OPENCODE_LAUNCH"
	Product                      = "opencode-peer"
	ToolName                     = "sessionbus"
	LaneSocketEnv                = "SESSIONBUS_LANE_SOCKET"
)

type Wrapper struct {
	kind               nativeKind
	planFollowup       bool
	messageIDs         messageIDs
	termOnce           sync.Once
	forceOnce          sync.Once
	stopErr            error
	socket, executable string
	caller             *kit.Caller
	shutdown           func()
	mu                 sync.Mutex
	ctx                context.Context
	cancel             context.CancelCauseFunc
	command            *exec.Cmd
	childDone          chan struct{}
	childErr           error
	output             io.ReadCloser
	workers            sync.WaitGroup
	eventWork          chan struct{}
	endpoint           *laneEndpoint
	client             *laneHTTP
	id                 string
	model              *modelRef
	agent              string
	opened, closing    bool
	run                *kit.Run
	active             *laneRun
	closeOnce          sync.Once
	closeErr           error
}

func NewOpenCode(socket, provisional, executable string) *Wrapper {
	return &Wrapper{socket: socket, executable: executable, eventWork: make(chan struct{}, 8)}
}
func (p *Wrapper) SetCaller(c *kit.Caller) { p.caller = c }
func (p *Wrapper) SetShutdown(f func())    { p.shutdown = f }
func (p *Wrapper) Hello(context.Context) (kit.HelloDescription, error) {
	return kit.HelloDescription{Product: p.kind.name() + "-peer", SupportsMessageRun: true, SupportedOpenFields: []string{"cwd", "permission_mode", "model", "arguments"}, ExtraArguments: []kit.ExtraArgument{{Name: "--agent", Description: "Native agent", TakesValue: true}, {Name: "--print-logs", Description: "Print native logs"}, {Name: "--log-level", Description: "Native log level", TakesValue: true}, {Name: "--mdns", Description: "Native mDNS discovery"}, {Name: "--mdns-domain", Description: "Native mDNS domain", TakesValue: true}, {Name: "--cors", Description: "Native allowed CORS origin", TakesValue: true}}}, nil
}
func (p *Wrapper) Open(ctx context.Context, request kit.OpenRequest) (result kit.OpenResult, err error) {
	if !filepath.IsAbs(p.executable) {
		return result, p.kind.err("executable must be absolute")
	}
	if p.caller == nil {
		return result, p.kind.err("lane Caller unavailable")
	}
	args, model, agent, err := launchArgumentsFor(p.kind, request.Open)
	if err != nil {
		return result, err
	}
	name, err := namePart(request.Name)
	if err != nil {
		return result, err
	}
	cwd, err := filepath.Abs(first(request.Open.Cwd, "."))
	if err != nil {
		return result, err
	}
	// Native session directories use the physical path. Keep the child and
	// directory-scoped HTTP requests on that same path (including /var aliases).
	cwd, err = filepath.EvalSymlinks(cwd)
	if err != nil {
		return result, err
	}
	p.mu.Lock()
	if p.ctx != nil || p.closing {
		p.mu.Unlock()
		return result, p.kind.err("owner already used")
	}
	p.ctx, p.cancel = context.WithCancelCause(context.WithoutCancel(ctx))
	p.model, p.agent = model, agent
	p.mu.Unlock()
	startupCtx, cancelStartup := context.WithCancelCause(p.ctx)
	startup := context.AfterFunc(ctx, func() { cancelStartup(ctx.Err()) })
	defer startup()
	created := ""
	defer func() {
		if err != nil {
			// Fresh rollback stays subject to startup cancellation and native loss.
			// Cancellation may prevent deletion; it must still reach joined Close.
			if created != "" && p.ctx.Err() == nil {
				err = errors.Join(err, p.client.remove(startupCtx, created))
			}
			err = errors.Join(err, p.Close(context.WithoutCancel(ctx), kit.SessionCloseRequest{}))
			p.mu.Lock()
			err = errors.Join(err, p.childErr)
			p.mu.Unlock()
		}
	}()
	_, password, err := credentials()
	if err != nil {
		return result, err
	}
	endpoint, err := newLaneEndpoint(p, password[:24])
	if err != nil {
		return result, err
	}
	p.endpoint = endpoint
	cmd := exec.Command(p.executable, append([]string{"serve", "--hostname", "127.0.0.1", "--port", "0"}, args...)...)
	cmd.Dir = cwd
	cmd.Stdin = strings.NewReader("")
	cmd.Env = scrub(os.Environ(), host.SocketEnv, host.LocalKeyEnv, host.TokenEnv, host.SessionIDEnv, host.NameEnv, host.GroupsEnv, LaneSocketEnv, "SESSIONBUS_OPENCODE_LAUNCH_DIR", opencodeInteractiveLaunchEnv, "OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD")
	if p.kind == kiloNative {
		cmd.Env = scrub(cmd.Env, "SESSIONBUS_KILO_LAUNCH", "KILO_SERVER_USERNAME", "KILO_SERVER_PASSWORD", "KILO_PARENT_PID")
		cmd.Env = append(cmd.Env, "KILO_PARENT_PID="+strconv.Itoa(os.Getpid()))
		p.planFollowup = supportsKiloPlanFollowup(cmd.Env)
	}
	cmd.Env = append(cmd.Env, LaneSocketEnv+"="+endpoint.Path, p.kind.envPrefix()+"_SERVER_USERNAME=sessionbus", p.kind.envPrefix()+"_SERVER_PASSWORD="+password)
	var logs boundedLog
	cmd.Stderr = &logs
	output, writer, err := os.Pipe()
	if err != nil {
		return result, err
	}
	cmd.Stdout = writer
	if err = cmd.Start(); err != nil {
		output.Close()
		writer.Close()
		return result, err
	}
	writer.Close()
	p.mu.Lock()
	p.command, p.output, p.childDone = cmd, output, make(chan struct{})
	p.mu.Unlock()
	ready := make(chan string, 1)
	p.workers.Add(3)
	go func() {
		defer p.workers.Done()
		e := cmd.Wait()
		p.mu.Lock()
		p.childErr = e
		close(p.childDone)
		p.mu.Unlock()
		p.fail(p.kind.err("server exited"))
	}()
	go func() {
		defer p.workers.Done()
		defer output.Close()
		scan := bufio.NewScanner(output)
		scan.Buffer(make([]byte, 4096), maxNativeRequest)
		announced := false
		for scan.Scan() {
			line := scan.Text()
			if strings.HasPrefix(line, p.kind.name()+" server listening on ") {
				if announced {
					p.fail(p.kind.err("announced multiple listeners"))
					return
				}
				address, e := listenerURL(strings.TrimPrefix(line, p.kind.name()+" server listening on "))
				if e != nil {
					p.fail(e)
					return
				}
				announced = true
				ready <- address
			}
		}
		if e := scan.Err(); e != nil {
			p.fail(e)
		} else {
			p.fail(p.kind.err("stdout ended"))
		}
	}()
	go func() {
		defer p.workers.Done()
		if p.kind == kiloNative {
			p.monitorKilo()
			return
		}
		<-p.ctx.Done()
		_ = cmd.Process.Kill()
		_ = output.Close()
		p.mu.Lock()
		run, opened, closing, shutdown := p.run, p.opened, p.closing, p.shutdown
		p.mu.Unlock()
		if run != nil {
			<-run.Done()
			p.clearRun(run)
		}
		if opened && !closing && shutdown != nil {
			shutdown()
		}
	}()
	var address string
	select {
	case address = <-ready:
	case <-startupCtx.Done():
		return result, context.Cause(startupCtx)
	}
	client := newLaneHTTP(address, cwd, "sessionbus", password)
	client.kind = p.kind
	p.mu.Lock()
	p.client = client
	p.mu.Unlock()
	// An event stream is established before session creation and model requests.
	// The plugin constructor must initialize the resident action connection
	// independently; there is no bootstrap timeout/cancel/retry loop here.
	events, err := client.events(startupCtx, p.observe)
	if err != nil {
		return result, err
	}
	p.workers.Add(1)
	go func() {
		defer p.workers.Done()
		cause := <-events
		p.mu.Lock()
		adopted := p.opened
		p.mu.Unlock()
		if adopted {
			p.fail(cause)
		} else {
			cancelStartup(cause)
		}
	}()
	if err = client.ready(startupCtx); err != nil {
		return result, err
	}
	session, e := client.openSession(startupCtx, request.ResumeSessionID, name, request.Open.PermissionMode)
	err = e
	if request.ResumeSessionID == "" && validNativeID(session.ID) {
		created = session.ID
	}
	if err != nil {
		return result, err
	}
	p.mu.Lock()
	p.id = session.ID
	p.mu.Unlock()
	select {
	case <-endpoint.ready:
	case <-startupCtx.Done():
		return result, context.Cause(startupCtx)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if ctx.Err() != nil || startupCtx.Err() != nil || p.ctx.Err() != nil || p.closing || !endpoint.live() {
		return result, p.kind.err("integration ended before Open adoption")
	}
	startup()
	if ctx.Err() != nil || startupCtx.Err() != nil {
		return result, errors.Join(ctx.Err(), context.Cause(startupCtx))
	}
	p.opened = true
	return kit.OpenResult{SessionID: session.ID}, nil
}
func (p *Wrapper) fail(err error) {
	if err == nil {
		err = p.kind.err("integration ended")
	}
	p.mu.Lock()
	if p.cancel != nil {
		p.cancel(err)
	}
	p.mu.Unlock()
}
func (p *Wrapper) clearRun(run *kit.Run) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.run == run {
		select {
		case <-run.Done():
			p.run = nil
		default:
		}
	}
}
func (p *Wrapper) Close(ctx context.Context, request kit.SessionCloseRequest) error {
	if p.kind == kiloNative {
		return p.closeKilo(ctx, request)
	}
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.closing = true
		client, id, cmd, cancel := p.client, p.id, p.command, p.cancel
		p.mu.Unlock()
		if request.Forget && client != nil && id != "" {
			p.closeErr = client.remove(ctx, id)
		}
		if cancel != nil {
			cancel(p.kind.err("owner closing"))
		}
		if cmd != nil {
			_ = cmd.Process.Kill()
		}
		if p.endpoint != nil {
			p.closeErr = errors.Join(p.closeErr, p.endpoint.Close())
		}
		p.workers.Wait()
		p.mu.Lock()
		if p.childErr != nil {
			var e *exec.ExitError
			if !errors.As(p.childErr, &e) || e.ExitCode() != -1 {
				p.closeErr = errors.Join(p.closeErr, p.childErr)
			}
		}
		p.mu.Unlock()
	})
	return p.closeErr
}
func listenerURL(value string) (string, error) {
	u, e := url.Parse(value)
	if e != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("invalid native listener announcement")
	}
	host, port, e := net.SplitHostPort(u.Host)
	ip := net.ParseIP(host)
	number, pe := strconv.Atoi(port)
	if e != nil || pe != nil || number < 1 || number > 65535 || ip == nil || !ip.IsLoopback() {
		return "", errors.New("native listener is not an actual loopback port")
	}
	return u.String(), nil
}

type boundedLog struct {
	mu   sync.Mutex
	data []byte
}

func (b *boundedLog) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	if left := (32 << 10) - len(b.data); left > 0 {
		if len(p) > left {
			p = p[:left]
		}
		b.data = append(b.data, p...)
	}
	return n, nil
}
func credentials() (string, string, error) {
	b := make([]byte, 32)
	_, e := rand.Read(b)
	return "sessionbus", hex.EncodeToString(b), e
}
func namePart(name string) (string, error) {
	i := strings.LastIndexByte(name, '@')
	if i < 1 {
		return "", errors.New("invalid lane name")
	}
	return name[:i], nil
}
func first(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
func scrub(env []string, names ...string) []string {
	out := make([]string, 0, len(env))
	for _, s := range env {
		k, _, _ := strings.Cut(s, "=")
		if !slices.Contains(names, k) {
			out = append(out, s)
		}
	}
	return out
}

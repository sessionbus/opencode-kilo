// SPDX-License-Identifier: MIT

package opencode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sessionbus/opencode-kilo/internal/pluginstage"
	"github.com/sessionbus/peer-common/mcp"
	"github.com/sessionbus/peer-common/testsocket"
)

type forwardOwner struct {
	entered, settled, ended chan struct{}
	once                    sync.Once
}

func (o *forwardOwner) Action(context.Context, string, json.RawMessage) (json.RawMessage, error) {
	return nil, errors.New("metadata dispatch was bypassed")
}
func (o *forwardOwner) ActionWithMeta(ctx context.Context, action string, _ json.RawMessage, meta json.RawMessage) (json.RawMessage, error) {
	var value map[string]map[string]string
	if json.Unmarshal(meta, &value) != nil || value["sessionbus.opencode"]["session_id"] != "ses_native" || value["sessionbus.opencode"]["message_id"] != "msg_native" {
		return nil, errors.New("native context was not forwarded")
	}
	if action == "wait" {
		close(o.entered)
		<-ctx.Done()
		close(o.settled)
		return nil, ctx.Err()
	}
	return json.Marshal(map[string]string{"escaped": strings.Repeat("<\n\\\"", 65536)})
}
func (o *forwardOwner) End() { o.once.Do(func() { close(o.ended) }) }

func TestNativeForwarderAgainstCommonEngine(t *testing.T) {
	for _, mode := range []string{"cancel", "eof"} {
		t.Run(mode, func(t *testing.T) {
			node, err := exec.LookPath("node")
			if err != nil {
				t.Skip("development Node unavailable")
			}
			stage := t.TempDir()
			if err := pluginstage.Stage("../..", "opencode", stage, true); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(testsocket.Directory(t), "mcp.sock")
			listener, err := net.Listen("unix", path)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, node, filepath.Join(stage, "forward-fixture.mjs"), path, mode)
			var output bytes.Buffer
			cmd.Stdout, cmd.Stderr = &output, &output
			input, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			defer input.Close()
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			wait := make(chan error, 1)
			go func() { wait <- cmd.Wait() }()
			accepted := make(chan net.Conn, 1)
			go func() { conn, _ := listener.Accept(); accepted <- conn }()
			var conn net.Conn
			select {
			case conn = <-accepted:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if conn == nil {
				t.Fatal("no connection")
			}
			defer conn.Close()
			owner := &forwardOwner{entered: make(chan struct{}), settled: make(chan struct{}), ended: make(chan struct{})}
			served := make(chan error, 1)
			go func() { served <- mcp.ServeSessionbus(owner, conn, conn, mcp.ReportHandler{}) }()
			select {
			case <-owner.entered:
			case <-ctx.Done():
				t.Fatal("action was not admitted", ctx.Err())
			}
			if mode == "cancel" {
				if _, err := input.Write([]byte("held\n")); err != nil {
					t.Fatal(err)
				}
			} else {
				_ = conn.Close()
			}
			select {
			case <-owner.settled:
			case <-ctx.Done():
				t.Fatal("native abort/EOF did not cancel Caller action", ctx.Err())
			}
			select {
			case err := <-wait:
				if err != nil {
					t.Fatalf("%v: %s", err, output.String())
				}
			case <-ctx.Done():
				t.Fatal("native forwarder did not exit", ctx.Err())
			}
			select {
			case err := <-served:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("MCP did not join", ctx.Err())
			}
			select {
			case <-owner.ended:
			default:
				t.Fatal("MCP owner was not ended")
			}
			if !strings.Contains(output.String(), "PASS "+mode) {
				t.Fatal(output.String())
			}
		})
	}
}

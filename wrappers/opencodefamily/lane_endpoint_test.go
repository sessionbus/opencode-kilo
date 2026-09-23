// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/sessionbus/peer-common/mcp"
)

type initializedToolObserver struct {
	*laneToolOwner
	initializedDone chan struct{}
	once            sync.Once
}

func (o *initializedToolObserver) Initialized() {
	o.laneToolOwner.Initialized()
	o.once.Do(func() { close(o.initializedDone) })
}

// Each fixture uses the actual common MCP codec and joins Serve after EOF.
// The in-memory endpoint excludes the accept loop so negative lifetime checks
// observe End completion, rather than racing a connection-close notification.
func TestLaneEndpointInitializedConnectionLossPolicy(t *testing.T) {
	for _, tc := range []struct {
		name                string
		initialize, dispose bool
		wantLoss            bool
	}{
		{"uninitialized EOF", false, false, false},
		{"initialized EOF with another live instance", true, false, true},
		{"owner teardown", true, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			life, cancel := context.WithCancelCause(context.Background())
			defer cancel(nil)
			p := &Wrapper{ctx: life, cancel: cancel}
			e := &laneEndpoint{owner: p, clients: map[net.Conn]*laneToolOwner{}, ready: make(chan struct{})}
			connect := func(initialize bool) (net.Conn, <-chan struct{}) {
				client, server := net.Pipe()
				_ = client.SetDeadline(time.Now().Add(5 * time.Second))
				o := &laneToolOwner{endpoint: e}
				observed := &initializedToolObserver{laneToolOwner: o, initializedDone: make(chan struct{})}
				e.mu.Lock()
				e.clients[server] = o
				e.mu.Unlock()
				done := make(chan struct{})
				go func() {
					defer close(done)
					defer server.Close()
					_ = mcp.ServeSessionbus(observed, server, server, mcp.ReportHandler{})
				}()
				t.Cleanup(func() { client.Close(); <-done })
				if initialize {
					_, err := io.WriteString(client, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"fixture\",\"version\":\"1\"}}}\n")
					if err != nil {
						t.Fatal(err)
					}
					line, err := bufio.NewReader(client).ReadBytes('\n')
					if err != nil {
						t.Fatal(err)
					}
					var frame map[string]json.RawMessage
					if json.Unmarshal(line, &frame) != nil || frame["result"] == nil {
						t.Fatalf("initialize: %s", line)
					}
					select {
					case <-observed.initializedDone:
					case <-time.After(5 * time.Second):
						t.Fatal("initialize response callback missing")
					}
				}
				return client, done
			}
			// This resident is kept alive while a second constructor comes and goes.
			survivor, survivorDone := connect(true)
			if !e.live() {
				t.Fatal("successful initialize did not establish readiness")
			}
			client, done := connect(tc.initialize)
			if tc.dispose {
				e.mu.Lock()
				e.closed = true
				e.mu.Unlock()
			}
			client.Close()
			<-done
			if (life.Err() != nil) != tc.wantLoss {
				t.Fatalf("loss=%v, want %v", context.Cause(life), tc.wantLoss)
			}
			if !tc.dispose && !e.live() {
				t.Fatal("surviving initialized instance was removed")
			}
			// Deliberate owner disposal suppresses helper-loss failure for the survivor.
			e.mu.Lock()
			e.closed = true
			e.mu.Unlock()
			survivor.Close()
			<-survivorDone
		})
	}
}

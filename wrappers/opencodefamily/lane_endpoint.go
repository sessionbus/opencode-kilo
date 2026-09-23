// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"sync"

	"github.com/sessionbus/peer-common/host"
	"github.com/sessionbus/peer-common/mcp"
)

type laneEndpoint struct {
	*host.PrivateEndpoint
	owner     *Wrapper
	mu        sync.Mutex
	clients   map[net.Conn]*laneToolOwner
	ready     chan struct{}
	readyOnce sync.Once
	closed    bool
	accepted  chan struct{}
	workers   sync.WaitGroup
}
type laneToolOwner struct {
	endpoint    *laneEndpoint
	initialized bool
}

func newLaneEndpoint(p *Wrapper, key string) (*laneEndpoint, error) {
	l, e := host.ListenPrivate(p.socket, key)
	if e != nil {
		return nil, e
	}
	endpoint := &laneEndpoint{PrivateEndpoint: l, owner: p, clients: map[net.Conn]*laneToolOwner{}, ready: make(chan struct{}), accepted: make(chan struct{})}
	go endpoint.serve()
	return endpoint, nil
}
func (e *laneEndpoint) serve() {
	defer close(e.accepted)
	for {
		c, err := e.Accept()
		if err != nil {
			return
		}
		e.mu.Lock()
		if e.closed || len(e.clients) >= 8 {
			e.mu.Unlock()
			c.Close()
			continue
		}
		o := &laneToolOwner{endpoint: e}
		e.clients[c] = o
		e.workers.Add(1)
		e.mu.Unlock()
		go func() {
			defer e.workers.Done()
			defer func() { c.Close(); e.mu.Lock(); delete(e.clients, c); e.mu.Unlock() }()
			_ = mcp.ServeSessionbus(o, c, c, mcp.ReportHandler{})
		}()
	}
}
func (o *laneToolOwner) Initialized() {
	e := o.endpoint
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.closed {
		o.initialized = true
		e.readyOnce.Do(func() { close(e.ready) })
	}
}
func (e *laneEndpoint) live() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return false
	}
	for _, o := range e.clients {
		if o.initialized {
			return true
		}
	}
	return false
}
func (o *laneToolOwner) End() {
	e := o.endpoint
	e.mu.Lock()
	lost := o.initialized && !e.closed
	o.initialized = false
	e.mu.Unlock()
	if lost {
		e.owner.fail(e.owner.kind.err("resident tool connection ended"))
	}
}
func (o *laneToolOwner) Action(ctx context.Context, action string, args json.RawMessage) (json.RawMessage, error) {
	return o.ActionWithMeta(ctx, action, args, nil)
}
func (o *laneToolOwner) ActionWithMeta(ctx context.Context, action string, args, meta json.RawMessage) (json.RawMessage, error) {
	p := o.endpoint.owner
	var envelope map[string]json.RawMessage
	var identity struct {
		SessionID string `json:"session_id"`
		MessageID string `json:"message_id"`
	}
	if json.Unmarshal(meta, &envelope) != nil || json.Unmarshal(envelope["sessionbus."+p.kind.name()], &identity) != nil || !validNativeID(identity.SessionID) || !validMessageID(identity.MessageID) {
		return nil, fmt.Errorf("missing or malformed native %s tool identity", p.kind.title())
	}
	p.mu.Lock()
	ready, caller := p.opened && !p.closing, p.caller
	p.mu.Unlock()
	if !ready || caller == nil {
		return nil, p.kind.err("lane not adopted")
	}
	if err := p.ownsSession(ctx, identity.SessionID); err != nil {
		return nil, err
	}
	return caller.Action(ctx, action, args)
}
func (p *Wrapper) ownsSession(ctx context.Context, id string) error {
	p.mu.Lock()
	root, c, life := p.id, p.client, p.ctx
	p.mu.Unlock()
	if root == "" || c == nil || life == nil || life.Err() != nil {
		return p.kind.err("native owner unavailable")
	}
	combined, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(life, cancel)
	defer stop()
	defer cancel()
	seen := map[string]bool{}
	for depth := 0; depth < 32; depth++ {
		if id == root {
			return nil
		}
		if !validNativeID(id) || seen[id] {
			return p.kind.err("tool is outside lane ancestry")
		}
		seen[id] = true
		s, e := c.get(combined, id)
		if e != nil {
			return e
		}
		id = s.ParentID
	}
	return p.kind.err("ancestry exceeds 32 sessions")
}
func (e *laneEndpoint) Close() error {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return nil
	}
	e.closed = true
	err := e.PrivateEndpoint.Close()
	for c := range e.clients {
		c.Close()
	}
	e.mu.Unlock()
	<-e.accepted
	e.workers.Wait()
	return err
}

// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sessionbus/peer-common/testsocket"
)

type recordingToolHost struct{ ended atomic.Int32 }

func (h *recordingToolHost) ToolAction(context.Context, string, string, string, json.RawMessage) (json.RawMessage, error) {
	return nil, errors.New("unused")
}
func (h *recordingToolHost) ToolEnded() { h.ended.Add(1) }

// refusedSocket leaves a socket file with no listener, as a worker killed
// without Close leaves its lane tool socket.
func refusedSocket(t *testing.T, path string) {
	t.Helper()
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	listener.(*net.UnixListener).SetUnlinkOnClose(false)
	if err = listener.Close(); err != nil {
		t.Fatal(err)
	}
}

func laneSocketDirectory(t *testing.T) (socket, lanes string) {
	t.Helper()
	root := testsocket.Directory(t)
	lanes = filepath.Join(root, "lanes")
	if err := os.Mkdir(lanes, 0o700); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(root, "bus.sock"), lanes
}

func present(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Lstat(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	return err == nil
}

func settle(t *testing.T, what string, done func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); !done(); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

const (
	deadLaneKey  = "0123456789abcdef01234567"
	liveLaneKey  = "89abcdef0123456789abcdef"
	freshLaneKey = "fedcba9876543210fedcba98"
)

// This test uses only names that exist before the dead-socket sweep, so it
// can run unchanged against the previous implementation, where the dead lane
// tool socket remains.
func TestLaneEndpointRemovesDeadLaneSockets(t *testing.T) {
	socket, lanes := laneSocketDirectory(t)
	live, err := newLaneEndpoint(&recordingToolHost{}, socket, liveLaneKey, "opencode", "OpenCode")
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()
	dead := filepath.Join(lanes, deadLaneKey+".sock")
	unpublished := filepath.Join(lanes, "t-"+deadLaneKey[2:]+".sock")
	otherHex := filepath.Join(lanes, "0123456789abcdef0123456789abcdef.sock")
	otherUUID := filepath.Join(lanes, "01234567-89ab-4cde-8f01-23456789abcd.sock")
	regular := filepath.Join(lanes, "aaaaaaaaaaaaaaaaaaaaaaaa.sock")
	for _, path := range []string{dead, unpublished, otherHex, otherUUID} {
		refusedSocket(t, path)
	}
	if err = os.WriteFile(regular, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	endpoint, err := newLaneEndpoint(&recordingToolHost{}, socket, freshLaneKey, "opencode", "OpenCode")
	if err != nil {
		t.Fatal(err)
	}
	if present(t, dead) {
		t.Fatal("dead lane tool socket remains after the next lane endpoint started")
	}
	for name, path := range map[string]string{
		"a live lane's socket": live.Path, "a socket not yet published": unpublished,
		"another product's 32-hex socket": otherHex, "another product's UUID socket": otherUUID, "a regular file": regular,
	} {
		if !present(t, path) {
			t.Fatalf("%s was removed", name)
		}
	}
	for name, path := range map[string]string{"live": live.Path, "new": endpoint.Path} {
		connection, dialErr := net.Dial("unix", path)
		if dialErr != nil {
			t.Fatalf("%s lane tool socket does not accept: %v", name, dialErr)
		}
		_ = connection.Close()
	}
	if want := filepath.Join(lanes, freshLaneKey+".sock"); endpoint.Path != want {
		t.Fatalf("path=%s, want %s", endpoint.Path, want)
	}
	if present(t, filepath.Join(lanes, "t-"+freshLaneKey[2:]+".sock")) {
		t.Fatal("temporary socket name remains after publication")
	}
	if err = endpoint.Close(); err != nil {
		t.Fatal(err)
	}
	if present(t, endpoint.Path) {
		t.Fatal("Close left the published lane tool socket")
	}
}

// The sweep probes a live lane's socket with one connection it closes at once.
func TestLaneEndpointBareProbeIsNotAToolLoss(t *testing.T) {
	socket, _ := laneSocketDirectory(t)
	owner := &recordingToolHost{}
	endpoint, err := newLaneEndpoint(owner, socket, liveLaneKey, "opencode", "OpenCode")
	if err != nil {
		t.Fatal(err)
	}
	defer endpoint.Close()
	clients := func() int { endpoint.mu.Lock(); defer endpoint.mu.Unlock(); return len(endpoint.clients) }
	probe, err := net.Dial("unix", endpoint.Path)
	if err != nil {
		t.Fatal(err)
	}
	_ = probe.Close()

	// Connections are accepted in order, so an initialized resident proves the
	// probe was accepted before it; the probe's handler has ended once only the
	// resident remains.
	resident, err := net.Dial("unix", endpoint.Path)
	if err != nil {
		t.Fatal(err)
	}
	_ = resident.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err = io.WriteString(resident, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"fixture\",\"version\":\"1\"}}}\n"); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(resident).ReadBytes('\n')
	if err != nil || !strings.Contains(string(line), "\"result\"") {
		t.Fatalf("initialize: %s %v", line, err)
	}
	settle(t, "the resident to initialize", endpoint.live)
	settle(t, "the probe's handler to end", func() bool { return clients() == 1 })
	if owner.ended.Load() != 0 {
		t.Fatal("a bare connect-then-close was reported as a tool loss")
	}
	// The recorder does observe a real loss: the initialized resident ends.
	_ = resident.Close()
	settle(t, "the resident's loss", func() bool { return owner.ended.Load() == 1 })
}

func TestLaneSocketPublicationFailureLeavesNoTemporarySocket(t *testing.T) {
	socket, lanes := laneSocketDirectory(t)
	blocked := filepath.Join(lanes, freshLaneKey+".sock")
	if err := os.MkdirAll(filepath.Join(blocked, "occupied"), 0o700); err != nil {
		t.Fatal(err)
	}
	if endpoint, err := newLaneEndpoint(&recordingToolHost{}, socket, freshLaneKey, "opencode", "OpenCode"); err == nil {
		_ = endpoint.Close()
		t.Fatal("publication over a directory succeeded")
	}
	entries, err := os.ReadDir(lanes)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != freshLaneKey+".sock" || !entries[0].IsDir() {
		t.Fatalf("entries after a failed publication: %v", entries)
	}
}

func TestListenLaneToolsRemovesDeadLaneSockets(t *testing.T) {
	socket, lanes := laneSocketDirectory(t)
	dead := filepath.Join(lanes, deadLaneKey+".sock")
	refusedSocket(t, dead)
	path, closeTools, err := ListenLaneTools(&recordingToolHost{}, socket, freshLaneKey, "opencode", "OpenCode")
	if err != nil {
		t.Fatal(err)
	}
	if present(t, dead) || path != filepath.Join(lanes, freshLaneKey+".sock") {
		t.Fatalf("dead socket present=%v path=%s", present(t, dead), path)
	}
	if err = closeTools(); err != nil || present(t, path) {
		t.Fatalf("close: %v present=%v", err, present(t, path))
	}
}

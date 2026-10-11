// SPDX-License-Identifier: MIT

//go:build linux

package opencodefamily

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

// These tests use only names that exist before the dead-socket sweep, so they
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

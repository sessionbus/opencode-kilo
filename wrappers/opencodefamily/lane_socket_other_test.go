// SPDX-License-Identifier: MIT

//go:build !linux

package opencodefamily

import (
	"path/filepath"
	"testing"
)

// Outside Linux a refused socket does not prove its worker is gone, so the
// lane endpoint removes nothing.
func TestLaneEndpointKeepsRefusedSocketsOutsideLinux(t *testing.T) {
	socket, lanes := laneSocketDirectory(t)
	dead := filepath.Join(lanes, deadLaneKey+".sock")
	refusedSocket(t, dead)
	endpoint, err := newLaneEndpoint(&recordingToolHost{}, socket, freshLaneKey, "opencode", "OpenCode")
	if err != nil {
		t.Fatal(err)
	}
	defer endpoint.Close()
	if !present(t, dead) {
		t.Fatal("a refused lane tool socket was removed outside Linux")
	}
}

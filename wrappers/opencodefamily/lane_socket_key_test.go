// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"os"
	"strings"
	"testing"
)

func TestLaneSocketKeyShape(t *testing.T) {
	socket, lanes := laneSocketDirectory(t)
	for _, key := range []string{"", "session", deadLaneKey[1:], deadLaneKey + "0", strings.ToUpper(liveLaneKey), "t-" + deadLaneKey[2:]} {
		if endpoint, err := newLaneEndpoint(&recordingToolHost{}, socket, key, "kilo", "Kilo"); err == nil {
			_ = endpoint.Close()
			t.Fatalf("key %q was accepted", key)
		}
	}
	if entries, err := os.ReadDir(lanes); err != nil || len(entries) != 0 {
		t.Fatalf("rejected keys left entries: %v %v", entries, err)
	}
	// Kilo's key is the head of its launch password.
	_, password, err := credentials()
	if err != nil || !laneKey(password[:laneKeyLength]) {
		t.Fatalf("Kilo lane key shape: %v", err)
	}
}

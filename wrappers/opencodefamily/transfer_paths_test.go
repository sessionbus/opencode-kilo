// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	kit "github.com/antst/sessionbus/bus/sdk/go"
)

// The shared helper's path table covers the transformation. This exercises the
// lane's actual dispatch boundary and its captured native base, with an
// unattached Worker caller: it is not a live lane or filesystem-transfer proof.
func TestKiloLaneTransferPathsUseNativeBaseBeforeWorkerCaller(t *testing.T) {
	p := &Wrapper{kind: kiloNative, opened: true, id: "ses_lane", ctx: context.Background(), client: newLaneHTTP("", "/native/lane", "", "")}
	worker := kit.NewWorker(p)
	p.SetCaller(worker.Caller())
	call := func(action, args string) error {
		_, err := p.ToolAction(context.Background(), "ses_lane", "msg_transfer", action, json.RawMessage(args))
		return err
	}
	for _, action := range []string{"transfer.offer", "transfer.accept"} {
		if err := call(action, `{"id":"x","Source":"relative"}`); err == nil || !strings.Contains(err.Error(), "unknown field") {
			t.Fatalf("alias bypassed binding for %s: %v", action, err)
		}
	}
	if err := call("transfer.offer", `{"target":"other@host","source":"relative"}`); err == nil || !strings.Contains(err.Error(), "unsupported_transfer") {
		t.Fatalf("known native base did not reach the unnegotiated caller: %v", err)
	}
	p.client.directory = ""
	if err := call("transfer.offer", `{"target":"other@host","source":"relative"}`); err == nil || !strings.Contains(err.Error(), "working directory is unknown") {
		t.Fatalf("unknown base was replaced by a process directory: %v", err)
	}
	if err := call("transfer.offer", `{"target":"other@host","source":"/absolute/source"}`); err == nil || !strings.Contains(err.Error(), "unsupported_transfer") {
		t.Fatalf("absolute path should reach caller after relative refusal: %v", err)
	}
	if err := call("transfer.status", `{"id":"x"}`); err == nil || !strings.Contains(err.Error(), "unsupported_transfer") {
		t.Fatalf("pathless action should still reach caller: %v", err)
	}
	p.closing = true
	if err := call("transfer.offer", `{"target":"other@host","source":"/absolute/source"}`); err == nil || !strings.Contains(err.Error(), "lane not adopted") {
		t.Fatalf("closing lane admitted a transfer: %v", err)
	}
}

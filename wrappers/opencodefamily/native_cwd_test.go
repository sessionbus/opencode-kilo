// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/sessionbus/peer-common/testsocket"
)

func TestNativeOpenThroughSymlinkDirectory(t *testing.T) {
	for _, resume := range []bool{false, true} {
		t.Run(map[bool]string{false: "fresh", true: "resume"}[resume], func(t *testing.T) {
			root := t.TempDir()
			physical := filepath.Join(root, "physical")
			if err := os.Mkdir(physical, 0o700); err != nil {
				t.Fatal(err)
			}
			alias := filepath.Join(root, "alias")
			if err := os.Symlink("physical", alias); err != nil {
				t.Fatal(err)
			}
			t.Setenv("OPENCODE_TEST_NATIVE", "1")
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			p := NewOpenCode(filepath.Join(testsocket.Directory(t), "bus.sock"), "unused", executable)
			p.SetCaller(kit.NewCaller(func(context.Context, string, any) (json.RawMessage, error) {
				return nil, errors.New("unexpected tool call")
			}))
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			t.Cleanup(func() {
				if err := p.Close(context.Background(), kit.SessionCloseRequest{}); err != nil {
					t.Errorf("close: %v", err)
				}
			})
			request := kit.OpenRequest{Name: "symlink@local", Open: kit.OpenOptions{Cwd: alias}}
			if resume {
				request.ResumeSessionID = "ses_native"
			}
			result, err := p.Open(ctx, request)
			if err != nil {
				t.Fatalf("native Open through directory alias: %v", err)
			}
			if result.SessionID != "ses_native" {
				t.Fatalf("native identity: %q", result.SessionID)
			}
		})
	}
}

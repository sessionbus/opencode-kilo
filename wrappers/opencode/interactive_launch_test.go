// SPDX-License-Identifier: MIT

package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/sessionbus/opencode-kilo/wrappers/opencodefamily"
	"github.com/sessionbus/peer-common/testsocket"
)

// The launcher execs native OpenCode: same PID, one launch variable naming that
// PID, no other Sessionbus variables, argv forwarded, native exit status kept.
func TestCompiledInteractiveLaunchExecsNative(t *testing.T) {
	bin := t.TempDir()
	for _, build := range []struct{ name, source string }{{"opencode", "./wrappers/opencode/testdata/interactive_native.go"}, {"opencode-peer", "./cmd/opencode-peer"}} {
		command := exec.Command("go", "build", "-o", filepath.Join(bin, build.name), build.source)
		command.Dir = "../.."
		if out, err := command.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v %s", build.name, err, out)
		}
	}
	canonicalBin, err := filepath.EvalSymlinks(bin)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"exit", "error"} {
		t.Run(mode, func(t *testing.T) {
			directory := testsocket.Directory(t)
			listener, err := net.Listen("unix", filepath.Join(directory, "report.sock"))
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			socket := filepath.Join(directory, "bus.sock")
			command := exec.CommandContext(ctx, filepath.Join(bin, "opencode-peer"), "--resume", "ses_resume", "-g", "one,two", "-n", "initial")
			command.Dir = bin
			command.Env = []string{"PATH=" + bin, "HOME=" + bin, "SESSIONBUS_SOCKET=" + socket, "SESSIONBUS_SESSION_ID=stale", "OC_TEST_SOCKET=" + listener.Addr().String(), "OC_TEST_MODE=" + mode}
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- command.Wait() }()
			if err := listener.(*net.UnixListener).SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			conn, err := listener.Accept()
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			var report struct {
				PID, PPID int
				CWD       string
				OldID     string `json:"old_id"`
				Args      []string
				Launch    launchBinding
			}
			if err := json.NewDecoder(conn).Decode(&report); err != nil {
				t.Fatal(err)
			}
			if report.PID != command.Process.Pid || report.Launch.PID != command.Process.Pid {
				t.Fatalf("native is not the exec'd launcher process: %+v", report)
			}
			if report.OldID != "" || report.Launch.Socket != socket || report.Launch.Name != "initial" || !slices.Equal(report.Launch.Groups, []string{"one", "two"}) {
				t.Fatalf("launch selection: %+v", report)
			}
			if !slices.Equal(report.Args, []string{"-s", "ses_resume"}) || report.CWD != canonicalBin {
				t.Fatalf("native argv/cwd changed: %+v", report)
			}
			select {
			case err := <-done:
				if mode == "error" {
					var exit *exec.ExitError
					if !errors.As(err, &exit) || exit.ExitCode() != 23 {
						t.Fatal("native exit status lost", err)
					}
				} else if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("native did not exit", ctx.Err())
			}
		})
	}
}

func TestLaunchCreatesSessionOnlyWhenNoneIsSelected(t *testing.T) {
	for _, tc := range []struct {
		args   []string
		create bool
	}{
		{nil, true},
		{[]string{"/work/project"}, true},
		{[]string{"--auto", "--log-level", "debug"}, true},
		{[]string{"--prompt", "hello"}, false},
		{[]string{"--prompt=hello"}, false},
		{[]string{"-s", "ses_x"}, false},
		{[]string{"--session=ses_x"}, false},
		{[]string{"-c"}, false},
		{[]string{"--continue"}, false},
		{[]string{"--", "--prompt", "literal"}, true},
	} {
		if got := !opencodefamily.SelectsSession(tc.args); got != tc.create {
			t.Fatalf("%v: create=%v, want %v", tc.args, got, tc.create)
		}
	}
}

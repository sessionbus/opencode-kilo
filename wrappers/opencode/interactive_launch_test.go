// SPDX-License-Identifier: MIT

package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"syscall"
	"testing"
	"time"

	"github.com/sessionbus/peer-common/testsocket"
)

func TestCompiledInteractiveLaunchOwnsChildAndResources(t *testing.T) {
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
	previous := ""
	for _, mode := range []string{"exit", "exit", "error", "term", "interrupt", "hup"} {
		t.Run(mode, func(t *testing.T) {
			directory := testsocket.Directory(t)
			listener, err := net.Listen("unix", filepath.Join(directory, "report.sock"))
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, filepath.Join(bin, "opencode-peer"), "--resume", "ses_resume", "-g", "one,two", "-n", "initial")
			command.Dir = bin
			command.Env = []string{"PATH=" + bin, "HOME=" + bin, "SESSIONBUS_SOCKET=" + filepath.Join(directory, "bus.sock"), "SESSIONBUS_SESSION_ID=stale", "OC_TEST_SOCKET=" + listener.Addr().String(), "OC_TEST_MODE=" + mode}
			if mode == "exit" {
				command.Env = append(command.Env, "OPENCODE_SERVER_USERNAME=caller", "OPENCODE_SERVER_PASSWORD=caller-password")
			}
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = command.Process.Kill() })
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
			if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			var report struct {
				PID, PPID               int
				CWD, Password, Username string
				OldID                   string `json:"old_id"`
				Args                    []string
				Launch                  interactiveLaunchBinding
			}
			decode := json.NewDecoder(conn)
			if err := decode.Decode(&report); err != nil {
				t.Fatal(err)
			}
			native, err := os.FindProcess(report.PID)
			if err != nil {
				t.Fatal(err)
			}
			reaped := false
			t.Cleanup(func() {
				if !reaped {
					_ = native.Signal(syscall.SIGTERM)
				}
			})
			if report.PPID != command.Process.Pid || report.Launch.PID != command.Process.Pid || report.OldID != "" {
				t.Fatalf("wrong direct native ownership: %+v", report)
			}
			if !slices.Equal(report.Args, []string{"--hostname=127.0.0.1", "--port=0", "-s", "ses_resume"}) || report.CWD != canonicalBin {
				t.Fatalf("native argv/cwd changed: %+v", report)
			}
			if !slices.Equal(report.Launch.Groups, []string{"one", "two"}) || report.Launch.Name != "initial" {
				t.Fatal(report.Launch)
			}
			if report.Launch.Directory == previous {
				t.Fatal("resume reused launch resources")
			}
			previous = report.Launch.Directory
			if mode == "exit" {
				if report.Username != "caller" || report.Password != "caller-password" {
					t.Fatal("caller auth changed")
				}
			} else if len(report.Password) != 64 {
				t.Fatal("per-launch native auth absent")
			}
			if mode == "interrupt" {
				if err := command.Process.Signal(os.Interrupt); err != nil {
					t.Fatal(err)
				}
				if err := native.Signal(os.Interrupt); err != nil {
					t.Fatal(err)
				}
				var event map[string]string
				if err := decode.Decode(&event); err != nil || event["event"] != "interrupt" {
					t.Fatalf("native interrupt translated into exit/TERM: %v %v", event, err)
				}
			}
			if mode == "term" || mode == "interrupt" {
				if err := command.Process.Signal(syscall.SIGTERM); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "hup" {
				if err := command.Process.Signal(syscall.SIGHUP); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err := <-done:
				reaped = true
				if mode == "error" {
					var exit *exec.ExitError
					if !errors.As(err, &exit) || exit.ExitCode() != 23 {
						t.Fatal("native exit status lost", err)
					}
				} else if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("launcher did not join native exit", ctx.Err())
			}
			if _, err := os.Stat(report.Launch.Directory); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("owned runtime directory retained", err)
			}
			if err := native.Signal(syscall.Signal(0)); err == nil {
				t.Fatal("native PID survived joined launcher")
			}
		})
	}
}

// SPDX-License-Identifier: MIT

package kilo

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/sessionbus/opencode-kilo/wrappers/opencodefamily"
	"github.com/sessionbus/peer-common/testsocket"
)

func TestCompiledKiloLauncherDirectLifetimeAndNativeResources(t *testing.T) {
	bin := t.TempDir()
	for _, build := range []struct{ name, source string }{{"kilo", "./wrappers/kilo/testdata/interactive_native.go"}, {"launcher", "./cmd/kilo-peer"}} {
		command := exec.Command("go", "build", "-o", filepath.Join(bin, build.name), build.source)
		command.Dir = "../.."
		if out, err := command.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v %s", build.name, err, out)
		}
	}
	resource := filepath.Join(bin, "tree-sitter")
	if err := os.Mkdir(resource, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resource, "tree-sitter.wasm"), []byte("native resource fixture"), 0644); err != nil {
		t.Fatal(err)
	}
	canonicalBin, err := filepath.EvalSymlinks(bin)
	if err != nil {
		t.Fatal(err)
	}
	previous := ""
	for _, mode := range []string{"exit", "exit", "error", "term", "hup", "interrupt"} {
		t.Run(mode, func(t *testing.T) {
			directory := testsocket.Directory(t)
			listener, err := net.Listen("unix", filepath.Join(directory, "report.sock"))
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, filepath.Join(bin, "launcher"), "--yolo", "--resume", "ses_resume", "-g", "one,two", "-n", "initial")
			command.Dir = bin
			command.Env = []string{"PATH=" + bin, "HOME=" + bin, "SESSIONBUS_SOCKET=" + filepath.Join(directory, "bus.sock"), "SESSIONBUS_SESSION_ID=stale", "SESSIONBUS_OPENCODE_LAUNCH=stale", "KILO_NO_DAEMON=old", "KILO_PARENT_PID=1", "KILO_TEST_SOCKET=" + listener.Addr().String(), "KILO_TEST_MODE=" + mode}
			if mode == "exit" {
				command.Env = append(command.Env, "KILO_SERVER_USERNAME=caller", "KILO_SERVER_PASSWORD=caller-password")
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
				PID, PPID                                         int
				CWD, Password, Username, Daemon, Parent, Resource string
				OldID                                             string `json:"old_id"`
				OldLaunch                                         string `json:"old_launch"`
				Args                                              []string
				Launch                                            opencodefamily.InteractiveLaunchBinding
			}
			decode := json.NewDecoder(conn)
			if err := decode.Decode(&report); err != nil {
				t.Fatal(err)
			}
			native, err := os.FindProcess(report.PID)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = native.Kill() })
			if report.PPID != command.Process.Pid || report.Launch.PID != command.Process.Pid || report.Parent != strconv.Itoa(command.Process.Pid) || report.OldID != "" || report.OldLaunch != "" {
				t.Fatalf("native ownership/env mismatch: %+v", report)
			}
			if report.Daemon != "1" || report.Resource != filepath.Join(bin, "tree-sitter") {
				t.Fatalf("native topology/resources mismatch: %+v", report)
			}
			if report.CWD != canonicalBin || !slices.Equal(report.Args, []string{"--hostname=127.0.0.1", "--port=0", "--yolo", "-s", "ses_resume"}) {
				t.Fatalf("argv/cwd changed: %+v", report)
			}
			if !slices.Equal(report.Launch.Groups, []string{"one", "two"}) || report.Launch.Name != "initial" {
				t.Fatal(report.Launch)
			}
			if report.Launch.Directory == previous {
				t.Fatal("resume reused transient resources")
			}
			previous = report.Launch.Directory
			if mode == "exit" {
				if report.Username != "caller" || report.Password != "caller-password" {
					t.Fatal("caller auth changed")
				}
			} else if len(report.Password) != 64 {
				t.Fatal("native auth absent")
			}
			expected := 0
			switch mode {
			case "error":
				expected = 23
			case "interrupt":
				expected = 130
				if err := command.Process.Signal(os.Interrupt); err != nil {
					t.Fatal(err)
				}
				if err := native.Signal(os.Interrupt); err != nil {
					t.Fatal(err)
				}
			case "term", "hup":
				expected = 143
				sig := syscall.SIGTERM
				if mode == "hup" {
					sig = syscall.SIGHUP
				}
				if err := command.Process.Signal(sig); err != nil {
					t.Fatal(err)
				}
				var event map[string]string
				if err := decode.Decode(&event); err != nil || event["event"] != "term" {
					t.Fatalf("native TERM missing %v %v", event, err)
				}
				select {
				case err := <-done:
					t.Fatalf("launcher did not join held native cleanup: %v", err)
				default:
				}
				if err := json.NewEncoder(conn).Encode(true); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err := <-done:
				if expected == 0 {
					if err != nil {
						t.Fatal(err)
					}
				} else {
					var exit *exec.ExitError
					if !errors.As(err, &exit) || exit.ExitCode() != expected {
						t.Fatalf("native exit lost expected %d: %v", expected, err)
					}
				}
			case <-ctx.Done():
				t.Fatal("launcher failed to join", ctx.Err())
			}
			if _, err := os.Stat(report.Launch.Directory); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("transient resources retained", err)
			}
			if err := native.Signal(syscall.Signal(0)); err == nil {
				t.Fatal("native process remains after launcher join")
			}
		})
	}
}

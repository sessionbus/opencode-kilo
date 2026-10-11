// SPDX-License-Identifier: MIT

package kilo

import (
	"bytes"
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

const registeredPlugin = `{"plugin":["@sessionbus/kilo"]}`

// compiledKiloLauncher builds the launcher and the fake native into one
// directory, with the native resource the launcher resolves next to it.
func compiledKiloLauncher(t *testing.T) (bin, canonicalBin string) {
	t.Helper()
	bin = t.TempDir()
	for _, build := range []struct{ name, source string }{{"kilo", "./wrappers/kilo/testdata/interactive_native.go"}, {"launcher", "./cmd/kilo-peer"}} {
		command := exec.Command("go", "build", "-o", filepath.Join(bin, build.name), build.source)
		command.Dir = "../.."
		if out, err := command.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v %s", build.name, err, out)
		}
	}
	writeLauncherFixture(t, filepath.Join(bin, "tree-sitter", "tree-sitter.wasm"), "native resource fixture")
	canonicalBin, err := filepath.EvalSymlinks(bin)
	if err != nil {
		t.Fatal(err)
	}
	return bin, canonicalBin
}

func writeLauncherFixture(t *testing.T, file, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A managed launch whose plugin lists positively lack our plugin is refused
// before the native starts. An answer the launcher cannot establish starts the
// native exactly as before.
func TestCompiledKiloLauncherRequiresThePluginRegistration(t *testing.T) {
	bin, canonicalBin := compiledKiloLauncher(t)
	// The restore command is offered only when the plugin package is next to the executable.
	writeLauncherFixture(t, filepath.Join(bin, "plugin", "package.json"), `{"name":"@sessionbus/kilo"}`)
	restore := "'" + filepath.Join(canonicalBin, "launcher") + "' --sessionbus-install --plugin-dir '" + filepath.Join(canonicalBin, "plugin") + "'"
	for _, tc := range []struct {
		name    string
		files   map[string]string
		missing string // empty: the native must be started
	}{
		{"no config directory", nil, "server and TUI"},
		{"both lists without ours", map[string]string{"kilo.jsonc": `{"plugin":["somebody-else"]}`, "tui.jsonc": `{}`}, "server and TUI"},
		{"tui list without ours", map[string]string{"kilo.jsonc": registeredPlugin, "tui.jsonc": `{"plugin":[]}`}, "TUI"},
		{"server list without ours", map[string]string{"kilo.jsonc": `{}`, "tui.jsonc": registeredPlugin}, "server"},
		{"plugin file but no TUI entry", map[string]string{"plugins/agent.js": "export default {}\n"}, "TUI"},
		{"unparsable files", map[string]string{"kilo.jsonc": `{ "plugin": [`, "tui.jsonc": `{`}, ""},
		{"env token entries", map[string]string{"kilo.jsonc": `{"plugin":["{env:OWNED}"]}`, "tui.jsonc": `{"plugin":["{env:OWNED}"]}`}, ""},
		{"plugin file and TUI entry", map[string]string{"plugins/agent.js": "export default {}\n", "tui.jsonc": registeredPlugin}, ""},
		{"both registered", map[string]string{"kilo.jsonc": registeredPlugin, "tui.jsonc": registeredPlugin}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			config := filepath.Join(home, ".config", "kilo")
			for name, body := range tc.files {
				writeLauncherFixture(t, filepath.Join(config, name), body)
			}
			directory := testsocket.Directory(t)
			listener, err := net.Listen("unix", filepath.Join(directory, "report.sock"))
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, filepath.Join(bin, "launcher"), "-g", "one", "-n", "gate")
			command.Dir = bin
			var stderr bytes.Buffer
			command.Stderr = &stderr
			command.Env = []string{"PATH=" + bin, "HOME=" + home, "SESSIONBUS_SOCKET=" + filepath.Join(directory, "bus.sock"), "KILO_TEST_SOCKET=" + listener.Addr().String(), "KILO_TEST_MODE=exit"}
			runErr := command.Run()
			// The fake native connects before it exits, and the launcher joins it, so a
			// started native has a connection waiting here.
			if err := listener.(*net.UnixListener).SetDeadline(time.Now().Add(300 * time.Millisecond)); err != nil {
				t.Fatal(err)
			}
			conn, acceptErr := listener.Accept()
			if acceptErr == nil {
				conn.Close()
			}
			started := acceptErr == nil
			if tc.missing == "" {
				if runErr != nil || !started || stderr.Len() != 0 {
					t.Fatalf("the native must start: err=%v started=%v stderr=%q", runErr, started, stderr.String())
				}
				return
			}
			want := "Kilo Sessionbus plugin is not in the " + tc.missing + " plugin list of " + config + ", which a managed launch requires; register it with: " + restore + "\n"
			var exit *exec.ExitError
			if started || !errors.As(runErr, &exit) || exit.ExitCode() != 1 || stderr.String() != want {
				t.Fatalf("the launch must be refused before the native starts: started=%v err=%v\nstderr %q\n  want %q", started, runErr, stderr.String(), want)
			}
			if left, _ := filepath.Glob(filepath.Join(directory, "kilo-*")); len(left) != 0 {
				t.Fatalf("a refused launch created %v", left)
			}
		})
	}
}

func TestCompiledKiloLauncherDirectLifetimeAndNativeResources(t *testing.T) {
	bin, canonicalBin := compiledKiloLauncher(t)
	// The launch environment below uses bin as HOME: register the plugin there.
	writeLauncherFixture(t, filepath.Join(bin, ".config", "kilo", "kilo.jsonc"), registeredPlugin)
	writeLauncherFixture(t, filepath.Join(bin, ".config", "kilo", "tui.jsonc"), registeredPlugin)
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
			// -s (from --resume) selects a session, so the TUI is not asked to create one.
			if !slices.Equal(report.Launch.Groups, []string{"one", "two"}) || report.Launch.Name != "initial" || report.Launch.Create {
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

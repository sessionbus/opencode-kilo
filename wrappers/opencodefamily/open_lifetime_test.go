// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/sessionbus/peer-common/testsocket"
)

func fakeOpenFailureNative(mode string, kind nativeKind) {
	if mode == "early-exit" {
		os.Exit(7)
	}
	cwd, _ := os.Getwd()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	srv := http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed, err := http.Post(os.Getenv("OPENCODE_TEST_OPEN_NOTIFY"), "text/plain", strings.NewReader(r.Method+" "+r.URL.Path))
		if err != nil {
			panic(err)
		}
		observed.Body.Close()
		switch {
		case r.URL.Path == "/event":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"type\":\"server.connected\",\"properties\":{}}\n\n")
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		case r.URL.Path == "/experimental/tool/ids":
			_ = json.NewEncoder(w).Encode([]string{ToolName})
		case r.URL.Path == "/session" && r.Method == "POST":
			_ = json.NewEncoder(w).Encode(nativeSession{ID: "ses_fresh", Title: "wrong", Directory: cwd})
		case r.URL.Path == "/session/ses_existing" && (r.Method == "GET" || r.Method == "PATCH"):
			_ = json.NewEncoder(w).Encode(nativeSession{ID: "ses_existing", Title: "wrong", Directory: cwd})
		case r.Method == "DELETE":
			_ = json.NewEncoder(w).Encode(true)
		default:
			http.NotFound(w, r)
		}
	})}
	nativeName := "opencode"
	if kind == kiloNative {
		nativeName = "kilo"
	}
	fmt.Printf("%s server listening on http://%s\n", nativeName, l.Addr())
	_ = srv.Serve(l)
}
func TestLegacyFailedOpenDeletesOnlyFreshAndReaps(t *testing.T) {
	testFailedOpenDeletesOnlyFreshAndReaps(t, openCodeNative)
}
func TestKiloFailedOpenDeletesOnlyFreshAndReaps(t *testing.T) {
	testFailedOpenDeletesOnlyFreshAndReaps(t, kiloNative)
}
func testFailedOpenDeletesOnlyFreshAndReaps(t *testing.T, kind nativeKind) {
	for _, mode := range []string{"fresh", "resume", "early-exit"} {
		t.Run(mode, func(t *testing.T) {
			calls := make(chan string, 16)
			notify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { b, _ := io.ReadAll(r.Body); calls <- string(b) }))
			defer notify.Close()
			if kind == kiloNative {
				t.Setenv("KILO_TEST_NATIVE", "1")
			} else {
				t.Setenv("OPENCODE_TEST_NATIVE", "1")
			}
			t.Setenv("OPENCODE_TEST_OPEN_MODE", mode)
			t.Setenv("OPENCODE_TEST_OPEN_NOTIFY", notify.URL)
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			p := NewOpenCode(filepath.Join(testsocket.Directory(t), "bus.sock"), "unused", executable)
			if kind == kiloNative {
				p = NewKilo(p.socket, "unused", executable)
			}
			p.SetCaller(kit.NewCaller(func(context.Context, string, any) (json.RawMessage, error) {
				return nil, errors.New("unexpected Caller action")
			}))
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			t.Cleanup(func() {
				p.fail(errors.New("fixture cleanup"))
				_ = p.Close(context.Background(), kit.SessionCloseRequest{})
			})
			request := kit.OpenRequest{Name: "wanted@local", Open: kit.OpenOptions{Cwd: t.TempDir()}}
			if mode == "resume" {
				request.ResumeSessionID = "ses_existing"
			}
			_, err = p.Open(ctx, request)
			if err == nil || ctx.Err() != nil {
				t.Fatalf("Open error=%v context=%v", err, ctx.Err())
			}
			p.mu.Lock()
			done, command := p.childDone, p.command
			p.mu.Unlock()
			if done == nil || command == nil {
				t.Fatal("fixture child never started")
			}
			select {
			case <-done:
			default:
				t.Fatal("Open returned before child reap")
			}
			if mode == "early-exit" && !strings.Contains(err.Error(), "exit status 7") {
				t.Fatalf("early native exit diagnostic lost: %v", err)
			}
			if kind == kiloNative && mode != "early-exit" {
				var killed *exec.ExitError
				if !errors.As(err, &killed) || killed.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL {
					t.Fatalf("failed pre-adoption Open did not preserve forced-child diagnostic: %v", err)
				}
			}
			if p.endpoint != nil {
				if _, err := os.Stat(p.endpoint.Path); !os.IsNotExist(err) {
					t.Fatalf("endpoint not removed: %v", err)
				}
			}
			var got []string
			for len(calls) > 0 {
				got = append(got, <-calls)
			}
			var want []string
			if mode == "fresh" {
				want = []string{"GET /event", "GET /experimental/tool/ids", "POST /session", "DELETE /session/ses_fresh"}
			}
			if mode == "resume" {
				want = []string{"GET /event", "GET /experimental/tool/ids", "GET /session/ses_existing", "PATCH /session/ses_existing"}
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("failed Open native operations=%v, want %v", got, want)
			}
		})
	}
}
func TestLegacyOpenNeverFallsBackToPATH(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	if err = os.Symlink(executable, filepath.Join(bin, "opencode")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	if found, err := exec.LookPath("opencode"); err != nil || found != filepath.Join(bin, "opencode") {
		t.Fatalf("PATH fixture=%q/%v", found, err)
	}
	for _, name := range []string{"opencode", ""} {
		p := NewOpenCode(filepath.Join(testsocket.Directory(t), "bus.sock"), "unused", name)
		p.SetCaller(kit.NewCaller(func(context.Context, string, any) (json.RawMessage, error) {
			return nil, errors.New("unexpected Caller action")
		}))
		_, err := p.Open(context.Background(), kit.OpenRequest{Name: "wanted@local"})
		if err == nil || !strings.Contains(err.Error(), "must be absolute") {
			t.Fatalf("nonabsolute executable accepted: %v", err)
		}
		if p.command != nil || p.ctx != nil {
			t.Fatal("PATH fallback created native lifetime")
		}
	}
}

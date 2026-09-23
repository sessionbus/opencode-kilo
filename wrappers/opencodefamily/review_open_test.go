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
	"path/filepath"
	"testing"
	"time"

	kit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/sessionbus/peer-common/testsocket"
)

func reviewStalledRollbackNative(kind nativeKind) {
	cwd, _ := os.Getwd()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	srv := http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/event":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"type\":\"server.connected\",\"properties\":{}}\n\n")
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		case r.URL.Path == "/experimental/tool/ids":
			_ = json.NewEncoder(w).Encode([]string{ToolName})
		case r.URL.Path == "/session" && r.Method == "POST":
			_ = json.NewEncoder(w).Encode(nativeSession{ID: "ses_created", Title: "mismatched", Directory: cwd})
		case r.URL.Path == "/session/ses_created" && r.Method == "DELETE":
			resp, e := http.Post(os.Getenv("OPENCODE_REVIEW_ROLLBACK_NOTIFY"), "text/plain", nil)
			if e != nil {
				panic(e)
			}
			resp.Body.Close()
			<-r.Context().Done()
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

func TestReviewCancelledFailedOpenBreaksHeldRollback(t *testing.T) {
	testCancelledFailedOpenBreaksHeldRollback(t, openCodeNative)
}
func TestKiloCancelledFailedOpenBreaksHeldRollback(t *testing.T) {
	testCancelledFailedOpenBreaksHeldRollback(t, kiloNative)
}
func testCancelledFailedOpenBreaksHeldRollback(t *testing.T, kind nativeKind) {
	entered := make(chan struct{})
	notify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered) }))
	defer notify.Close()
	if kind == kiloNative {
		t.Setenv("KILO_TEST_NATIVE", "1")
	} else {
		t.Setenv("OPENCODE_TEST_NATIVE", "1")
	}
	t.Setenv("OPENCODE_REVIEW_ROLLBACK_NOTIFY", notify.URL)
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
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		_, _ = p.Open(ctx, kit.OpenRequest{Name: "wanted@local", Open: kit.OpenOptions{Cwd: t.TempDir()}})
		close(done)
	}()
	defer func() { p.fail(errors.New("review fixture teardown")); <-done }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("rollback did not enter")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled failed Open retained child while rollback DELETE remained blocked")
	}
	p.mu.Lock()
	childDone := p.childDone
	p.mu.Unlock()
	select {
	case <-childDone:
	default:
		t.Fatal("Open returned before reaping owned child")
	}
}

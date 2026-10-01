// SPDX-License-Identifier: MIT

package opencode

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The lane ensures the user's service with native's own `service start`,
// without lane identity in its environment, and trusts only a registration
// that names the started v2 service.
func TestServiceHostEnsuresAndReadsTheRegistration(t *testing.T) {
	var bound string
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Basic b3BlbmNvZGU6c2VjcmV0" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var body map[string]map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		bound = r.URL.Path + "?" + r.URL.RawQuery + " " + body["input"]["sessionID"] + " " + body["input"]["socket"]
		w.Write([]byte(`{"output":{}}`))
	}))
	defer service.Close()
	dir := t.TempDir()
	envFile := filepath.Join(dir, "env")
	executable := filepath.Join(dir, "opencode")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\nenv > "+envFile+"\necho \""+service.URL+"\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(dir, "state")
	t.Setenv("XDG_STATE_HOME", state)
	t.Setenv("SESSIONBUS_SOCKET", "/bus.sock")
	t.Setenv("SESSIONBUS_LANE_TOKEN", "secret-token")
	register := func(url, version string) {
		os.MkdirAll(filepath.Join(state, "opencode"), 0o700)
		b, _ := json.Marshal(map[string]any{"url": url, "password": "secret", "version": version, "pid": 1})
		if err := os.WriteFile(filepath.Join(state, "opencode", "service.json"), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	register(service.URL, "2.0.21")
	h := &serviceHost{executable: executable}
	client, err := h.start(context.Background(), "/work/dir", "/tools.sock")
	if err != nil {
		t.Fatal(err)
	}
	env, _ := os.ReadFile(envFile)
	if strings.Contains(string(env), "SESSIONBUS_") {
		t.Fatalf("service start saw lane identity: %s", env)
	}
	if err := h.bind(context.Background(), client, "ses_l", "/tools.sock"); err != nil {
		t.Fatal(err)
	}
	if bound != "/api/rpc/sessionbus/lane?location%5Bdirectory%5D=%2Fwork%2Fdir ses_l /tools.sock" {
		t.Fatalf("bound %q", bound)
	}
	if err := h.close(); err != nil {
		t.Fatal(err)
	}

	register("http://127.0.0.1:1", "2.0.21")
	if _, err := h.start(context.Background(), "/work/dir", ""); err == nil || !strings.Contains(err.Error(), "not the started") {
		t.Fatalf("mismatched registration: %v", err)
	}
	register(service.URL, "1.18.34")
	if _, err := h.start(context.Background(), "/work/dir", ""); err == nil || !strings.Contains(err.Error(), "not OpenCode v2") {
		t.Fatalf("v1 service: %v", err)
	}
}

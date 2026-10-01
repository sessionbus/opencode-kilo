// SPDX-License-Identifier: MIT

package opencode

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// NewServiceLane drives one lane through the user's shared native OpenCode
// service, as native's own `opencode run` does (owner decision 2026-10-01): the
// user's logins, history and default model apply. A service restart ends the
// lane's Run and native may then continue that turn by itself; killing the
// worker does not stop a running turn. Both are native behaviour.
func NewServiceLane(socket, executable string) *Lane {
	return newLane(socket, &serviceHost{executable: executable})
}

// serviceHost reaches the shared native service. It ensures the service with
// native's own `service start` and never stops it.
type serviceHost struct {
	executable string
	cwd        string
}

func (h *serviceHost) start(ctx context.Context, cwd, _ string) (*nativeClient, error) {
	if !filepath.IsAbs(h.executable) {
		return nil, errors.New("OpenCode executable must be absolute")
	}
	h.cwd = cwd
	var stdout, stderr bytes.Buffer
	command := exec.CommandContext(ctx, h.executable, "service", "start")
	// A service this starts keeps its environment for every client: no lane
	// identity or bus credential goes into it.
	command.Env = withoutSessionbus(os.Environ())
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("OpenCode service start: %w: %s", err, strings.TrimSpace(tail(stderr.String(), 512)))
	}
	lines := strings.Fields(stdout.String())
	if len(lines) == 0 {
		return nil, errors.New("OpenCode service start printed no URL")
	}
	started := lines[len(lines)-1]
	registration, err := readRegistration()
	if err != nil {
		return nil, err
	}
	if registration.URL != started {
		return nil, fmt.Errorf("OpenCode service registration names %s, not the started %s", registration.URL, started)
	}
	if !strings.HasPrefix(registration.Version, "2.") {
		return nil, fmt.Errorf("OpenCode service %s is not OpenCode v2", registration.Version)
	}
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte("opencode:"+registration.Password))
	// The lane reads events inline; a native request stalls it at most this long.
	return &nativeClient{base: strings.TrimRight(started, "/"), auth: auth, http: &http.Client{Timeout: 30 * time.Second}}, nil
}

// bind lets the session's Sessionbus tool reach the lane's endpoint through
// the plugin instance of the session's directory.
func (h *serviceHost) bind(ctx context.Context, client *nativeClient, session, tools string) error {
	path := "/api/rpc/sessionbus/lane?" + url.Values{"location[directory]": {h.cwd}}.Encode()
	return client.call(ctx, "POST", path, map[string]any{"input": map[string]string{"sessionID": session, "socket": tools}}, nil)
}

// close leaves the shared service running: it is the user's, not the lane's.
func (h *serviceHost) close() error { return nil }

type registration struct {
	URL      string `json:"url"`
	Password string `json:"password"`
	Version  string `json:"version"`
}

// readRegistration reads native's service registration; the password stays
// in memory.
func readRegistration() (registration, error) {
	state := os.Getenv("XDG_STATE_HOME")
	if state == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return registration{}, err
		}
		state = filepath.Join(home, ".local", "state")
	}
	b, err := os.ReadFile(filepath.Join(state, "opencode", "service.json"))
	if err != nil {
		return registration{}, fmt.Errorf("OpenCode service registration: %w", err)
	}
	var r registration
	if json.Unmarshal(b, &r) != nil || r.URL == "" || r.Password == "" {
		return registration{}, errors.New("OpenCode service registration is malformed")
	}
	return r, nil
}

func withoutSessionbus(environment []string) []string {
	kept := make([]string, 0, len(environment))
	for _, entry := range environment {
		if !strings.HasPrefix(entry, "SESSIONBUS_") {
			kept = append(kept, entry)
		}
	}
	return kept
}

func tail(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

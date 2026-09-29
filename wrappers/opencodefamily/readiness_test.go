// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	kit "github.com/antst/sessionbus/bus/sdk/go"
)

func TestLegacyToolReadinessRequiresExactInventory(t *testing.T) {
	for _, tc := range []struct {
		body string
		ok   bool
	}{
		{`["sessionbus"]`, true}, {`["other","sessionbus"]`, true},
		{`null`, false}, {`[]`, false}, {`["prefix_sessionbus"]`, false}, {`{}`, false}, {`[null]`, false},
	} {
		t.Run(tc.body, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/experimental/tool/ids" {
					t.Errorf("unexpected discovery route %s", r.URL.Path)
				}
				_, _ = io.WriteString(w, tc.body)
			}))
			defer s.Close()
			c := newLaneHTTP(s.URL, "/work", "u", "p")
			if err := c.ready(context.Background()); (err == nil) != tc.ok {
				t.Fatalf("ready=%v, want success=%v", err, tc.ok)
			}
		})
	}
}
func TestLegacyDeleteRequiresTrueJSONConfirmation(t *testing.T) {
	for _, tc := range []struct {
		body string
		ok   bool
	}{
		{`true`, true}, {" \ntrue\n", true}, {`false`, false}, {`null`, false}, {`"true"`, false}, {`true false`, false},
	} {
		t.Run(tc.body, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "DELETE" || r.URL.Path != "/session/ses_test" {
					t.Errorf("unexpected deletion %s %s", r.Method, r.URL.Path)
				}
				_, _ = io.WriteString(w, tc.body)
			}))
			defer s.Close()
			c := newLaneHTTP(s.URL, "/work", "u", "p")
			if err := c.remove(context.Background(), "ses_test"); (err == nil) != tc.ok {
				t.Fatalf("delete=%v, want success=%v", err, tc.ok)
			}
		})
	}
}
func TestLegacyWorkerExplicitForgetAcceptsNativeJSON(t *testing.T) {
	for _, forget := range []bool{false, true} {
		t.Run(map[bool]string{false: "ordinary", true: "forget"}[forget], func(t *testing.T) {
			f := newWorkerFixture(t)
			f.call(t, "session.close", kit.SessionCloseRequest{SessionID: "ses_native@local", Forget: forget}, nil)
		})
	}
}

// forget never deletes product-owned native history for an existing native
// session; only the failed-fresh-open rollback path in Open does that.
func TestOpenCodeCloseForgetNeverDeletesExistingNativeHistory(t *testing.T) {
	for _, forget := range []bool{false, true} {
		t.Run(map[bool]string{false: "ordinary", true: "forget"}[forget], func(t *testing.T) {
			calls := 0
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
			defer s.Close()
			p := &Wrapper{client: newLaneHTTP(s.URL, "/work", "u", "p"), id: "ses_existing"}
			if err := p.Close(context.Background(), kit.SessionCloseRequest{Forget: forget}); err != nil {
				t.Fatalf("close: %v", err)
			}
			if calls != 0 {
				t.Fatalf("forget=%v reached native HTTP %d time(s)", forget, calls)
			}
		})
	}
}

func TestLegacyOpenNativeRepliesAndResumeOrder(t *testing.T) {
	for _, tc := range []struct{ name, resume, permission, wrong string }{
		{name: "fresh default"}, {name: "fresh explicit bypass", permission: "bypassPermissions"},
		{name: "resume default", resume: "ses_existing"}, {name: "resume bypass", resume: "ses_existing", permission: "bypassPermissions"},
		{name: "wrong read ID", resume: "ses_existing", wrong: "read"},
		{name: "wrong committed ID", resume: "ses_existing", wrong: "id"},
		{name: "wrong title", wrong: "title"}, {name: "wrong directory", wrong: "directory"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := make(chan string, 4)
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls <- r.Method + " " + r.URL.Path
				id := "ses_created"
				if tc.resume != "" {
					id = tc.resume
				}
				result := nativeSession{ID: id, Title: "wanted", Directory: "/work"}
				if r.Method == "GET" {
					if tc.wrong == "read" {
						result.ID = "ses_unrelated"
					}
				} else {
					var body map[string]json.RawMessage
					if json.NewDecoder(r.Body).Decode(&body) != nil {
						t.Error("bad request JSON")
					}
					if string(body["title"]) != `"wanted"` {
						t.Errorf("title request %s", body["title"])
					}
					if tc.permission == "" {
						if _, exists := body["permission"]; exists {
							t.Error("default permission overwritten")
						}
					} else {
						var rules []map[string]string
						if json.Unmarshal(body["permission"], &rules) != nil || len(rules) != 1 || rules[0]["permission"] != "*" || rules[0]["pattern"] != "*" || rules[0]["action"] != "allow" {
							t.Errorf("explicit native permission: %s", body["permission"])
						}
					}
					switch tc.wrong {
					case "id":
						result.ID = "ses_unrelated"
					case "title":
						result.Title = "different"
					case "directory":
						result.Directory = "/other"
					}
				}
				_ = json.NewEncoder(w).Encode(result)
			}))
			defer s.Close()
			c := newLaneHTTP(s.URL, "/work", "u", "p")
			_, err := c.openSession(context.Background(), tc.resume, "wanted", tc.permission)
			if (err != nil) != (tc.wrong != "") {
				t.Fatalf("open error=%v", err)
			}
			var got []string
			for len(calls) > 0 {
				got = append(got, <-calls)
			}
			want := []string{"POST /session"}
			if tc.resume != "" {
				want = []string{"GET /session/ses_existing", "PATCH /session/ses_existing"}
			}
			if tc.wrong == "read" {
				want = want[:1]
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("native sequence %v, want %v", got, want)
			}
		})
	}
}

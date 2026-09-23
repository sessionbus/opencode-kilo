// SPDX-License-Identifier: MIT
package sessionbus_peers_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

func TestRepositoryBoundary(t *testing.T) {
	for _, p := range []string{"cmd/claude-peer", "cmd/codex-peer", "cmd/grok-peer", "cmd/qwen-peer", "cmd/pi-peer", "cmd/omp-peer", "wrappers/host", "wrappers/mcp", "internal/peerversion", "internal/testsocket", "scripts/cleanup-legacy"} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("removed product or shared source remains: %s", p)
		}
	}
	if got := directoryNames(t, "cmd"); !equalStrings(got, []string{"kilo-peer", "opencode-peer"}) {
		t.Errorf("command roots = %v", got)
	}
	if got := directoryNames(t, "wrappers"); !equalStrings(got, []string{"kilo", "opencode", "opencodefamily"}) {
		t.Errorf("wrapper roots = %v", got)
	}
	if got := directoryNames(t, "internal"); !equalStrings(got, []string{"cmd", "pluginstage"}) {
		t.Errorf("internal roots = %v", got)
	}
}

func TestModuleAndImportBoundary(t *testing.T) {
	mod := string(read(t, "go.mod"))
	for _, s := range []string{"module github.com/sessionbus/opencode-kilo", "github.com/sessionbus/peer-common v0.0.0-20260922143100-eb655f686e44", "github.com/antst/sessionbus/bus/sdk/go v0.5.7"} {
		if !strings.Contains(mod, s) {
			t.Errorf("missing module binding %q", s)
		}
	}
	if strings.Contains(mod, "replace ") {
		t.Fatal("filesystem module replacement is forbidden")
	}
	filepath.WalkDir(".", func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		f, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, i := range f.Imports {
			imp := strings.Trim(i.Path.Value, "\"")
			if strings.HasPrefix(imp, "github.com/antst/sessionbus-peers/") {
				t.Errorf("old import in %s: %s", path, imp)
			}
		}
		return nil
	})
	cmd := exec.Command("go", "list", "-m", "all")
	cmd.Env = append(os.Environ(), "GOWORK=off")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("module graph: %v\n%s", err, out)
	}
}

func TestOpenCodePackageBoundary(t *testing.T) { testNativePackageBoundary(t, "opencode") }
func TestKiloPackageBoundary(t *testing.T)     { testNativePackageBoundary(t, "kilo") }
func testNativePackageBoundary(t *testing.T, product string) {
	t.Helper()
	var manifest struct {
		Name       string            `json:"name"`
		Bin        map[string]string `json:"bin"`
		Files      []string          `json:"files"`
		Repository struct {
			Type      string `json:"type"`
			URL       string `json:"url"`
			Directory string `json:"directory"`
		} `json:"repository"`
		Dependencies map[string]string `json:"dependencies"`
	}
	if err := json.Unmarshal(read(t, product+"/package.json"), &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Name != "@sessionbus/"+product || len(manifest.Bin) != 0 {
		t.Fatalf("Native package unexpectedly requires a Node installer: %#v", manifest)
	}
	wantFiles := []string{"README.md", "activation.mjs", "delivery.mjs", "endpoint.mjs", "forward.mjs", "gate.mjs", "owners.mjs", "peer.mjs", "profile.mjs", "readiness.mjs", "server.mjs", "sessionbus-tool.json", "skills", "tui.mjs"}
	sort.Strings(manifest.Files)
	if !equalStrings(manifest.Files, wantFiles) {
		t.Errorf("Native package files = %v, want %v", manifest.Files, wantFiles)
	}
	if manifest.Repository.Type != "git" || manifest.Repository.URL != "git+https://github.com/sessionbus/opencode-kilo.git" || manifest.Repository.Directory != product {
		t.Errorf("Native repository metadata is invalid: %#v", manifest.Repository)
	}
	if len(manifest.Dependencies) != 1 || manifest.Dependencies["@sessionbus/kit"] != "0.5.7" || strings.HasPrefix(manifest.Dependencies["@sessionbus/kit"], "file:") {
		t.Errorf("Native kit dependency is not exact: %q", manifest.Dependencies["@sessionbus/kit"])
	}
	workflow := read(t, ".github/workflows/pkg-pr-new.yml")
	if !bytes.Contains(workflow, []byte(`for PRODUCT in opencode kilo; do`)) ||
		!bytes.Contains(workflow, []byte(`pkg-pr-new publish "$RUNNER_TEMP/native-plugin/opencode" "$RUNNER_TEMP/native-plugin/kilo"`)) ||
		bytes.Count(workflow, []byte("pkg-pr-new publish ")) != 1 || bytes.Contains(workflow, []byte("integrations/opencode")) {
		t.Fatal("pkg.pr.new does not publish the fixed native product stages")
	}
}

func TestProductFactsHistoricalCitations(t *testing.T) {
	pattern := regexp.MustCompile("`([0-9a-f]{7,40}:[^`\\s]+)`")
	var citations []string
	header := "> Historical source note: citations to pre-split Sessionbus paths resolve in\n> the Forgejo `ai/sessionbus` repository through its `legacy-*` branches.\n> Citations to product source resolve in the external repository and full\n> commit recorded by the split archive manifest. Host evidence paths are\n> immutable external artifacts, not repository paths."
	for _, product := range []string{"opencode", "kilo"} {
		body := read(t, "docs/products/"+product+".md")
		if !bytes.Contains(body, []byte(header)) {
			t.Errorf("missing history qualification: %s", product)
		}
		for _, m := range pattern.FindAllSubmatch(body, -1) {
			citations = append(citations, string(m[1]))
		}
	}
	sort.Strings(citations)
	digest := sha256.Sum256([]byte(strings.Join(citations, "\n") + "\n"))
	if len(citations) != 105 || hex.EncodeToString(digest[:]) != "834644fe9f622493893fa2afd6acac0ada713290013033f88d6591f4b5539e8a" {
		t.Fatalf("historical citations changed: count=%d sha=%x", len(citations), digest)
	}
}

func TestRetainedManifestCommandReachability(t *testing.T) {
	for _, product := range []string{"opencode", "kilo"} {
		var manifest struct {
			Bin map[string]string `json:"bin"`
		}
		if err := json.Unmarshal(read(t, product+"/package.json"), &manifest); err != nil {
			t.Fatal(err)
		}
		if len(manifest.Bin) != 0 {
			t.Errorf("%s adds a Node installer", product)
		}
	}
	for _, name := range []string{"server.mjs", "tui.mjs"} {
		if !regular(t, "wrappers/opencodefamily/plugin/"+name) {
			t.Errorf("missing regular native entry: %s", name)
		}
	}
	installer := read(t, "scripts/release/install-product")
	for _, product := range []string{"opencode", "kilo"} {
		exact := `"$root/` + product + `-peer" --sessionbus-install --plugin-dir "$root/plugin"`
		if !bytes.Contains(installer, []byte(exact)) {
			t.Errorf("missing Go maintenance install: %s", product)
		}
	}
	if bytes.Contains(installer, []byte("node ")) {
		t.Error("target installer invokes Node")
	}
}
func TestReadmeIsTheSourceInstallAuthority(t *testing.T) {
	body := read(t, "README.md")
	for _, s := range []string{"scripts/package-product opencode", "scripts/package-product kilo", "scripts/install-opencode.sh", "scripts/install-kilo.sh", "github.com/sessionbus/opencode-kilo"} {
		if !bytes.Contains(body, []byte(s)) {
			t.Errorf("README lacks %s", s)
		}
	}
}
func regular(t *testing.T, p string) bool {
	t.Helper()
	info, err := os.Lstat(p)
	return err == nil && info.Mode().IsRegular()
}
func directoryNames(t *testing.T, p string) []string {
	t.Helper()
	entries, err := os.ReadDir(p)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names
}
func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
func read(t *testing.T, p string) []byte {
	t.Helper()
	v, e := os.ReadFile(p)
	if e != nil {
		t.Fatal(e)
	}
	return v
}

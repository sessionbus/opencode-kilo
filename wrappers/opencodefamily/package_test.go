// SPDX-License-Identifier: MIT

package opencodefamily

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLiteralArchiveInstallsTwiceWithoutNodeAndImportsNativeEntries(t *testing.T) {
	testLiteralNativeArchive(t, "opencode")
}

func TestLiteralKiloArchiveInstallsTwiceWithoutNodeAndImportsNativeEntries(t *testing.T) {
	testLiteralNativeArchive(t, "kilo")
}

func testLiteralNativeArchive(t *testing.T, product string) {
	t.Helper()
	out := t.TempDir()
	// Stage under a symlinked TMPDIR: macOS runners resolve /var to /private/var,
	// and npm ci through a symlinked project path fails lockfile validation.
	physical := filepath.Join(t.TempDir(), "physical")
	if err := os.Mkdir(physical, 0o700); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(physical, linked); err != nil {
		t.Fatal(err)
	}
	build := exec.Command("sh", "../../scripts/package-product", product, out)
	build.Env = append(os.Environ(), "TMPDIR="+linked)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("archive build: %v\n%s", err, output)
	}
	archive := filepath.Join(out, fmt.Sprintf(product+"-peer-%s-%s.tar.gz", runtime.GOOS, runtime.GOARCH))
	file, err := os.Open(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	zipped, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer zipped.Close()
	reader := tar.NewReader(zipped)
	payload := filepath.Join(out, "payload")
	modules := map[string]bool{}
	skills := 0
	for {
		h, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if filepath.IsAbs(h.Name) || strings.Contains(h.Name, "..") {
			t.Fatal("unsafe archive", h.Name)
		}
		target := filepath.Join(payload, h.Name)
		if h.Typeflag == tar.TypeDir {
			if err := os.MkdirAll(target, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if h.Typeflag != tar.TypeReg {
			t.Fatal("unexpected archive type", h.Name, h.Typeflag)
		}
		if strings.HasSuffix(h.Name, ".test.mjs") || strings.Contains(h.Name, "fixture") || strings.HasSuffix(h.Name, "/bin.mjs") || strings.HasSuffix(h.Name, "/install.mjs") || strings.HasSuffix(h.Name, "/sessionbus.mjs") {
			t.Fatal("stale/development payload", h.Name)
		}
		if strings.HasPrefix(h.Name, "plugin/node_modules/") && !strings.HasPrefix(h.Name, "plugin/node_modules/@sessionbus/kit/") && h.Name != "plugin/node_modules/.package-lock.json" {
			t.Fatal("unexpected JS runtime dependency", h.Name)
		}
		if strings.HasSuffix(h.Name, "/SKILL.md") {
			skills++
			if h.Name != "plugin/skills/sessionbus/SKILL.md" {
				t.Fatal("non-generic skill", h.Name)
			}
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, body, os.FileMode(h.Mode)); err != nil {
			t.Fatal(err)
		}
		modules[h.Name] = true
	}
	if skills != 1 {
		t.Fatal("wrong generic skill count", skills)
	}
	entries := []string{"server.mjs", "tui.mjs", "peer.mjs", "owners.mjs", "delivery.mjs", "sessionbus-tool.json"}
	// Without managed launch metadata neither native entry activates.
	imports := `import server from './server.mjs'; import tui from './tui.mjs'; if (Object.keys(await server.server()).length || await tui.tui({}) !== undefined) throw Error('ordinary activation');`
	if product == "opencode" {
		entries = []string{"server.mjs", "tui.mjs", "contract.mjs", "peer.mjs", "delivery.mjs", "sessionbus-tool.json"}
		imports = `import server from './server.mjs'; import tui from './tui.mjs'; if (server.id !== 'sessionbus' || typeof server.setup !== 'function' || await tui.setup({}) !== undefined) throw Error('ordinary activation');`
	}
	for _, entry := range entries {
		if !modules["plugin/"+entry] {
			t.Fatal("missing native module", entry)
		}
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	check := exec.Command(node, "--input-type=module", "-e", imports)
	check.Dir = filepath.Join(payload, "plugin")
	check.Env = []string{"PATH=" + os.Getenv("PATH")}
	if output, err := check.CombinedOutput(); err != nil {
		t.Fatalf("actual packed entry imports: %v %s", err, output)
	}
	home := filepath.Join(out, "real home #test")
	tools := filepath.Join(out, "tools")
	if err := os.MkdirAll(tools, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"cat", "dirname", "mkdir", "mktemp", "cp", "install", "mv", "rm", "ln"} {
		executable, err := exec.LookPath(name)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(executable, filepath.Join(tools, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(tools, product), []byte("#!/bin/sh\necho native runtime must not run during install >&2\nexit 97\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(home, ".config", product)
	if err := os.MkdirAll(config, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config, product+".jsonc"), []byte("{// retained comment\n\"plugin\":[[\"other\",{\"number\":1e30}],\"@sessionbus/"+product+"@old\"]}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(home, ".local", "libexec", "sessionbus", product)
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Fatal(err)
	}
	var firstConfig []byte
	for round := 0; round < 2; round++ {
		stale := filepath.Join(root, "plugin", "skills", product+"-lane")
		if err := os.MkdirAll(stale, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(stale, "SKILL.md"), []byte("obsolete"), 0o644); err != nil {
			t.Fatal(err)
		}
		command := exec.Command(shell, filepath.Join(payload, "install"))
		command.Env = []string{"HOME=" + home, "PATH=" + tools}
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("literal install%d without Node: %v %s", round, err, output)
		}
		if _, err := os.Stat(stale); !os.IsNotExist(err) {
			t.Fatal("stale skill retained", err)
		}
		file := filepath.Join(config, product+".jsonc")
		physicalSkills, err := filepath.EvalSymlinks(filepath.Join(root, "plugin", "skills"))
		if err != nil {
			t.Fatal(err)
		}
		if got := installedSkillPaths(t, file); len(got) != 1 || got[0] != physicalSkills {
			t.Fatal("wrong bundled skill registration", got)
		}
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if round == 0 {
			firstConfig = body
		} else if string(body) != string(firstConfig) {
			t.Fatal("repeat changed native skill/plugin config")
		}
	}
	want := (&url.URL{Scheme: "file", Path: filepath.Join(root, "plugin")}).String()
	for _, name := range []string{product + ".jsonc", "tui.jsonc"} {
		entries := installedPluginEntries(t, filepath.Join(config, name), false)
		count := 0
		for _, entry := range entries {
			if entry == want {
				count++
			}
		}
		if count != 1 {
			t.Fatal("wrong native config registration", name, entries)
		}
	}
	nativeConfig, err := os.ReadFile(filepath.Join(config, product+".jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(nativeConfig), "// retained comment") || !strings.Contains(string(nativeConfig), `["other",{"number":1e30}]`) {
		t.Fatal("unrelated native config rewritten", string(nativeConfig))
	}
	var manifest struct {
		Dependencies map[string]string `json:"dependencies"`
		Bin          any               `json:"bin"`
	}
	b, err := os.ReadFile(filepath.Join(root, "plugin", "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Bin != nil || len(manifest.Dependencies) != 1 || manifest.Dependencies["@sessionbus/kit"] != "0.5.10" {
		t.Fatal("wrong installed dependency or installer", manifest)
	}
	remove := exec.Command(filepath.Join(root, product+"-peer"), "--sessionbus-install", "--remove")
	remove.Env = []string{"HOME=" + home, "PATH=" + tools}
	if output, err := remove.CombinedOutput(); err != nil {
		t.Fatalf("actual uninstall: %v %s", err, output)
	}
	if got := installedSkillPaths(t, filepath.Join(config, product+".jsonc")); len(got) != 0 {
		t.Fatal("retained bundled skill registration", got)
	}
	for _, name := range []string{product + ".jsonc", "tui.jsonc"} {
		for _, entry := range installedPluginEntries(t, filepath.Join(config, name), false) {
			if entry == want {
				t.Fatal("retained owned plugin", name)
			}
		}
	}
}

// A release builds foreign archives on the current host; only the peer binary
// uses the requested target. The Go staging helper must remain executable here.
func TestCrossArchiveRunsStagerOnBuildHost(t *testing.T) {
	targetOS := "darwin"
	if runtime.GOOS == "darwin" {
		targetOS = "linux"
	}
	out := t.TempDir()
	build := exec.Command("sh", "../../scripts/package-product", "opencode", out)
	build.Env = append(os.Environ(), "GOOS="+targetOS, "GOARCH=amd64")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("cross archive: %v\n%s", err, output)
	}
	file, err := os.Open(filepath.Join(out, "opencode-peer-"+targetOS+"-amd64.tar.gz"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	zipped, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer zipped.Close()
	reader := tar.NewReader(zipped)
	for {
		header, err := reader.Next()
		if err != nil {
			t.Fatal("missing cross-built peer", err)
		}
		if header.Name != "opencode-peer" {
			continue
		}
		var magic [4]byte
		if _, err := io.ReadFull(reader, magic[:]); err != nil {
			t.Fatal(err)
		}
		want := [4]byte{0xcf, 0xfa, 0xed, 0xfe}
		if targetOS == "linux" {
			want = [4]byte{0x7f, 'E', 'L', 'F'}
		}
		if magic != want {
			t.Fatalf("product target %s magic %x, want %x", targetOS, magic, want)
		}
		break
	}
}

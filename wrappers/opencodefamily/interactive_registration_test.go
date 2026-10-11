// SPDX-License-Identifier: MIT

package opencodefamily

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeRegistrationFile(t *testing.T, file, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestManagedRegistrationClassifiesEachGroup(t *testing.T) {
	packages := t.TempDir()
	writeRegistrationFile(t, filepath.Join(packages, "ours", "package.json"), `{"name":"@sessionbus/kilo"}`)
	writeRegistrationFile(t, filepath.Join(packages, "other", "package.json"), `{"name":"somebody-else"}`)
	writeRegistrationFile(t, filepath.Join(packages, "unnamed", "package.json"), `{}`)
	writeRegistrationFile(t, filepath.Join(packages, "broken", "package.json"), `{`)
	ours, other := filepath.Join(packages, "ours"), filepath.Join(packages, "other")
	const owned, listed = `{"plugin":["@sessionbus/kilo"]}`, `{"plugin":["somebody-else","@scope/thing@1.2.3"]}`
	entry := func(spec string) string { return `{"plugin":["` + spec + `"]}` }
	for _, tc := range []struct {
		name        string
		files       map[string]string
		server, tui registration
	}{
		{"both present", map[string]string{"kilo.jsonc": owned, "tui.jsonc": owned}, registrationPresent, registrationPresent},
		{"server list without ours", map[string]string{"kilo.jsonc": listed, "tui.jsonc": owned}, registrationAbsent, registrationPresent},
		{"tui list without ours", map[string]string{"kilo.jsonc": owned, "tui.jsonc": listed}, registrationPresent, registrationAbsent},
		{"no plugin key in either", map[string]string{"kilo.jsonc": `{"model":"x"}`, "tui.jsonc": `{}`}, registrationAbsent, registrationAbsent},
		{"empty lists", map[string]string{"kilo.jsonc": `{"plugin":[]}`, "tui.json": `{"plugin":[]}`}, registrationAbsent, registrationAbsent},
		{"no files at all", map[string]string{}, registrationAbsent, registrationAbsent},
		{"ours in a later file of the group", map[string]string{"kilo.jsonc": listed, "opencode.json": owned, "tui.json": owned}, registrationPresent, registrationPresent},
		{"version and tuple forms of ours", map[string]string{"kilo.jsonc": entry("@sessionbus/kilo@0.5.12"), "tui.jsonc": `{"plugin":[["@sessionbus/kilo",{"a":1}]]}`}, registrationPresent, registrationPresent},
		{"nested tui object", map[string]string{"kilo.jsonc": owned, "tui.jsonc": `{"tui":{"plugin":["@sessionbus/kilo"]}}`}, registrationPresent, registrationPresent},
		{"file URL of our package", map[string]string{"kilo.jsonc": entry("file://" + ours), "tui.jsonc": entry("file://" + ours)}, registrationPresent, registrationPresent},
		{"bare absolute path of our package", map[string]string{"kilo.jsonc": entry(ours), "tui.jsonc": owned}, registrationPresent, registrationPresent},
		{"our release archive name", map[string]string{"kilo.jsonc": entry("https://example.invalid/sessionbus-kilo-0.5.12.tgz"), "tui.jsonc": owned}, registrationPresent, registrationPresent},
		{"path of another package", map[string]string{"kilo.jsonc": entry("file://" + other), "tui.jsonc": entry(other)}, registrationAbsent, registrationAbsent},

		{"unparsable file", map[string]string{"kilo.jsonc": `{ "plugin": [`, "tui.jsonc": listed}, registrationUnknown, registrationAbsent},
		{"unparsable beside a file with ours", map[string]string{"kilo.jsonc": `{`, "kilo.json": owned, "tui.jsonc": owned}, registrationPresent, registrationPresent},
		{"plugin is not a list", map[string]string{"kilo.jsonc": `{"plugin":"@sessionbus/kilo"}`, "tui.jsonc": `{"plugin":{}}`}, registrationUnknown, registrationUnknown},
		{"entry is not a specifier", map[string]string{"kilo.jsonc": `{"plugin":[42]}`, "tui.jsonc": owned}, registrationUnknown, registrationPresent},
		{"env token entry", map[string]string{"kilo.jsonc": entry("{env:KILO_OWNED_PLUGIN}"), "tui.jsonc": entry("{file:./plugin-name}")}, registrationUnknown, registrationUnknown},
		{"token in a key", map[string]string{"kilo.jsonc": `{"{env:KEY}":["x"]}`, "tui.jsonc": `{"tui":{"{file:k}":[]}}`}, registrationUnknown, registrationUnknown},
		{"file package that cannot be read", map[string]string{"kilo.jsonc": entry("file://" + filepath.Join(packages, "missing")), "tui.jsonc": entry("file://" + filepath.Join(packages, "broken"))}, registrationUnknown, registrationUnknown},
		{"path package without a name", map[string]string{"kilo.jsonc": entry(filepath.Join(packages, "unnamed")), "tui.jsonc": entry("./relative-missing")}, registrationUnknown, registrationUnknown},
		{"URL, git and alias entries", map[string]string{"kilo.jsonc": `{"plugin":["https://example.invalid/plugin.tgz","git:example.invalid/x"]}`, "tui.jsonc": entry("alias@npm:somebody-else")}, registrationUnknown, registrationUnknown},
		{"file URL on another host", map[string]string{"kilo.jsonc": entry("file://elsewhere/pkg"), "tui.jsonc": owned}, registrationUnknown, registrationPresent},
		{"a commented entry is not an entry", map[string]string{"kilo.jsonc": "{\n  // \"plugin\": [\"@sessionbus/kilo\"]\n  \"plugin\": [\"somebody-else\"]\n}", "tui.jsonc": owned}, registrationAbsent, registrationPresent},
	} {
		t.Run(tc.name, func(t *testing.T) {
			directory := filepath.Join(t.TempDir(), "kilo")
			for name, body := range tc.files {
				writeRegistrationFile(t, filepath.Join(directory, name), body)
			}
			if server, tui := managedRegistration(kiloNative, directory); server != tc.server || tui != tc.tui {
				t.Fatalf("server=%d tui=%d, want server=%d tui=%d", server, tui, tc.server, tc.tui)
			}
		})
	}
}

// Native loads plugin files of a config directory as server plugins without a
// list entry. Their existence makes the server group unknown; the TUI group
// has no such route.
func TestManagedRegistrationPluginFilesMakeOnlyTheServerGroupUnknown(t *testing.T) {
	for _, tc := range []struct{ name, file string }{
		{"plugins js", "plugins/agent.js"},
		{"plugin ts", "plugin/local.ts"},
		{"dot file", "plugins/.hidden.js"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			directory := filepath.Join(t.TempDir(), "kilo")
			writeRegistrationFile(t, filepath.Join(directory, tc.file), "export default {}\n")
			if server, tui := managedRegistration(kiloNative, directory); server != registrationUnknown || tui != registrationAbsent {
				t.Fatalf("server=%d tui=%d", server, tui)
			}
		})
	}
	t.Run("other files do not count", func(t *testing.T) {
		directory := filepath.Join(t.TempDir(), "kilo")
		writeRegistrationFile(t, filepath.Join(directory, "plugins", "README.md"), "x")
		writeRegistrationFile(t, filepath.Join(directory, "plugins", "nested", "deep.js"), "x")
		if server, tui := managedRegistration(kiloNative, directory); server != registrationAbsent || tui != registrationAbsent {
			t.Fatalf("server=%d tui=%d", server, tui)
		}
	})
	t.Run("a present server list is not downgraded", func(t *testing.T) {
		directory := filepath.Join(t.TempDir(), "kilo")
		writeRegistrationFile(t, filepath.Join(directory, "kilo.jsonc"), `{"plugin":["@sessionbus/kilo"]}`)
		writeRegistrationFile(t, filepath.Join(directory, "plugins", "agent.js"), "x")
		if server, _ := managedRegistration(kiloNative, directory); server != registrationPresent {
			t.Fatalf("server=%d", server)
		}
	})
	t.Run("a folder that cannot be listed", func(t *testing.T) {
		if os.Getuid() == 0 {
			t.Skip("root reads any directory")
		}
		directory := filepath.Join(t.TempDir(), "kilo")
		folder := filepath.Join(directory, "plugins")
		if err := os.MkdirAll(folder, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(folder, 0); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(folder, 0o700) })
		if server, tui := managedRegistration(kiloNative, directory); server != registrationUnknown || tui != registrationAbsent {
			t.Fatalf("server=%d tui=%d", server, tui)
		}
	})
}

func TestRequireManagedRegistrationRefusesOnlyPositiveAbsence(t *testing.T) {
	home := t.TempDir()
	directory := filepath.Join(home, ".config", "kilo")
	environment := []string{"HOME=" + home}
	refusal := func(t *testing.T, missing string) {
		t.Helper()
		err := requireManagedRegistration(kiloNative, "Kilo", environment)
		// The test binary has no plugin package next to it, so no command is offered.
		want := "Kilo Sessionbus plugin is not in the " + missing + " plugin list of " + directory + ", which a managed launch requires; run the kilo-peer installer again"
		if err == nil || err.Error() != want {
			t.Fatalf("refusal:\n got %v\nwant %s", err, want)
		}
	}
	refusal(t, "server and TUI") // no directory
	writeRegistrationFile(t, filepath.Join(directory, "kilo.jsonc"), `{"plugin":["@sessionbus/kilo"]}`)
	refusal(t, "TUI")
	writeRegistrationFile(t, filepath.Join(directory, "tui.jsonc"), `{"plugin":["@sessionbus/kilo"]}`)
	if err := requireManagedRegistration(kiloNative, "Kilo", environment); err != nil {
		t.Fatalf("both registered: %v", err)
	}
	writeRegistrationFile(t, filepath.Join(directory, "kilo.jsonc"), `{"plugin":["somebody-else"]}`)
	refusal(t, "server")
	writeRegistrationFile(t, filepath.Join(directory, "kilo.jsonc"), `{ not JSONC`)
	if err := requireManagedRegistration(kiloNative, "Kilo", environment); err != nil {
		t.Fatalf("an unparsable file must not refuse: %v", err)
	}
	// The directory follows the child's environment, and an undeterminable one never refuses.
	elsewhere := t.TempDir()
	for name, env := range map[string][]string{
		"XDG_CONFIG_HOME wins":     {"HOME=" + t.TempDir(), "XDG_CONFIG_HOME=" + filepath.Join(home, ".config")},
		"relative XDG_CONFIG_HOME": {"HOME=" + elsewhere, "XDG_CONFIG_HOME=relative"},
		"no HOME":                  {"PATH=/usr/bin"},
		// Native strips CR and LF from the root, so these name the registered
		// directory to native and an empty one to a raw read.
		"newline in XDG_CONFIG_HOME":         {"HOME=" + elsewhere, "XDG_CONFIG_HOME=" + filepath.Join(home, ".config") + "\n"},
		"carriage return in XDG_CONFIG_HOME": {"HOME=" + elsewhere, "XDG_CONFIG_HOME=" + filepath.Join(home, ".config") + "\r"},
		"newline in HOME":                    {"HOME=" + home + "\n"},
		"carriage return inside HOME":        {"HOME=" + filepath.Dir(home) + "\r/" + filepath.Base(home)},
	} {
		if err := requireManagedRegistration(kiloNative, "Kilo", env); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if err := requireManagedRegistration(kiloNative, "Kilo", []string{"HOME=" + elsewhere}); err == nil || !strings.Contains(err.Error(), filepath.Join(elsewhere, ".config", "kilo")) {
		t.Fatalf("an empty home must refuse and name its directory: %v", err)
	}
}

func TestShellQuoteIsPasteable(t *testing.T) {
	for in, want := range map[string]string{"/a/b": "'/a/b'", "/with space/x": "'/with space/x'", "/it's": `'/it'\''s'`} {
		if got := shellQuote(in); got != want {
			t.Fatalf("%q: %s", in, got)
		}
	}
}

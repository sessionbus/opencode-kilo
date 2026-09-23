// SPDX-License-Identifier: MIT

// Package pluginstage assembles self-contained native plugin build inputs.
// It is not linked into a product command or used on the installation target.
package pluginstage

import (
	"fmt"
	"os"
	"path/filepath"
)

var runtimeFiles = []string{
	"activation.mjs", "delivery.mjs", "endpoint.mjs", "forward.mjs", "gate.mjs",
	"owners.mjs", "peer.mjs", "profile.mjs", "readiness.mjs", "server.mjs", "tui.mjs",
}
var testFiles = []string{
	"delivery.test.mjs", "endpoint.test.mjs", "forward.test.mjs", "owners.test.mjs",
	"peer.test.mjs", "readiness.test.mjs", "readiness-fixture.mjs", "server.test.mjs", "tui.test.mjs",
	"review-delivery-idle.test.mjs", "review-delivery-receipt.test.mjs", "forward-fixture.mjs",
}

// Stage copies the fixed product payload into an empty destination. Tests adds
// development fixtures only; npm's explicit files allowlist excludes them.
func Stage(repo, product, destination string, tests bool) error {
	if product != "opencode" && product != "kilo" {
		return fmt.Errorf("unsupported native plugin product %q", product)
	}
	if err := os.MkdirAll(destination, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(destination)
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		return fmt.Errorf("native plugin stage must be empty: %s", destination)
	}
	copyFile := func(source, name string) error {
		info, err := os.Lstat(source)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("native plugin source is not regular: %s", source)
		}
		body, err := os.ReadFile(source)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, name)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return os.WriteFile(target, body, 0o644)
	}
	for _, name := range runtimeFiles {
		if err := copyFile(filepath.Join(repo, "wrappers", "opencodefamily", "plugin", name), name); err != nil {
			return err
		}
	}
	for _, name := range []string{"package.json", "package-lock.json", "README.md"} {
		if err := copyFile(filepath.Join(repo, product, name), name); err != nil {
			return err
		}
	}
	if err := copyFile(filepath.Join(repo, "wrappers", "opencodefamily", "plugin", "sessionbus-tool.json"), "sessionbus-tool.json"); err != nil {
		return err
	}
	skill, err := renderSkill(repo, product)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(destination, "skills", "sessionbus"), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(destination, "skills", "sessionbus", "SKILL.md"), skill, 0o644); err != nil {
		return err
	}
	if tests {
		for _, name := range testFiles {
			if err := copyFile(filepath.Join(repo, "wrappers", "opencodefamily", "plugin", name), name); err != nil {
				return err
			}
		}
		if err := copyFile(filepath.Join(repo, "internal", "pluginstage", "testdata", "native-message-envelope.json"), "native-message-envelope.json"); err != nil {
			return err
		}
	}
	return nil
}

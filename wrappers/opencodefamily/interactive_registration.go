// SPDX-License-Identifier: MIT

package opencodefamily

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// registration is what the launcher can tell, without starting the native,
// about one group of plugin lists in the native global config directory.
type registration int

const (
	// registrationUnknown: something in the group is not fully understood by
	// this reader. A launch is never refused for it.
	registrationUnknown registration = iota
	// registrationPresent: a list entry in the group is ours.
	registrationPresent
	// registrationAbsent: every existing file of the group was read and parsed,
	// and every list entry in it is fully understood and is not ours.
	registrationAbsent
)

// A plain npm specifier: name or @scope/name with an optional version or tag.
// Aliases, URLs, git and other schemes do not match and stay unknown.
var plainPackageSpecifier = regexp.MustCompile(`^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*(@[A-Za-z0-9._~^*+-]+)?$`)

// Native substitutes these tokens in the config text before it parses, so a
// string carrying one is not the string native uses.
func nativeToken(text string) bool {
	return strings.Contains(text, "{env:") || strings.Contains(text, "{file:")
}

// managedRegistration reports the server group and the TUI group of the native
// global config directory. It reads the plugin lists of the files the installer
// manages and nothing else.
func managedRegistration(kind nativeKind, directory string) (server, tui registration) {
	groups := kind.installConfigNames()
	server, tui = groupRegistration(kind, directory, groups[0], false), groupRegistration(kind, directory, groups[1], true)
	// Native also loads {plugin,plugins}/*.{ts,js} of a config directory as
	// server plugins, with no list entry. Such a file is not read here; its
	// existence alone means the server group cannot be called absent.
	if server == registrationAbsent && nativePluginFiles(directory) {
		server = registrationUnknown
	}
	return server, tui
}

func groupRegistration(kind nativeKind, directory string, names []string, tui bool) registration {
	unknown := false
	for _, name := range names {
		doc, err := readConfigDocument(filepath.Join(directory, name))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			unknown = true
			continue
		}
		doc.kind, doc.tui = kind, tui
		targets, err := configPluginTargets(doc)
		if err != nil {
			unknown = true
			continue
		}
		for _, target := range targets {
			for _, key := range target.keys {
				if nativeToken(key) {
					unknown = true
				}
			}
			plugin, err := target.property("plugin")
			if err != nil || plugin != nil && plugin.kind != '[' {
				unknown = true
				continue
			}
			if plugin == nil {
				continue
			}
			for _, entry := range plugin.items {
				spec, err := configEntrySpecifier(entry)
				if err != nil {
					unknown = true
					continue
				}
				switch entryRegistration(kind, spec, doc.file) {
				case registrationPresent:
					return registrationPresent
				case registrationUnknown:
					unknown = true
				}
			}
		}
	}
	if unknown {
		return registrationUnknown
	}
	return registrationAbsent
}

// entryRegistration classifies one list entry: ours, fully understood and not
// ours, or unknown.
func entryRegistration(kind nativeKind, spec, configFile string) registration {
	if nativeToken(spec) {
		return registrationUnknown
	}
	if ownedInstallSpecifier(kind, spec, configFile) {
		return registrationPresent
	}
	name, known, path := "", false, false
	switch {
	case strings.HasPrefix(spec, "file:"):
		path = true
		name, known = filePackageName(specifierLocation(spec), configFile)
	case strings.HasPrefix(spec, ".") || filepath.IsAbs(spec):
		path = true
		name, known = directoryPackageName(spec, configFile)
	}
	if path {
		switch {
		case !known || name == "":
			return registrationUnknown
		case name == kind.installPackage():
			return registrationPresent
		}
		return registrationAbsent
	}
	if plainPackageSpecifier.MatchString(spec) {
		return registrationAbsent
	}
	return registrationUnknown
}

func nativePluginFiles(directory string) bool {
	for _, folder := range []string{"plugin", "plugins"} {
		entries, err := os.ReadDir(filepath.Join(directory, folder))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return true
		}
		for _, entry := range entries {
			if name := entry.Name(); strings.HasSuffix(name, ".ts") || strings.HasSuffix(name, ".js") {
				return true
			}
		}
	}
	return false
}

// nativeGlobalConfigDirectory resolves the directory as the native child will,
// from the child's environment. Empty means it cannot be determined here.
func nativeGlobalConfigDirectory(kind nativeKind, environment []string) string {
	root := InteractiveEnvironmentValue(environment, "XDG_CONFIG_HOME")
	if root == "" {
		home := InteractiveEnvironmentValue(environment, "HOME")
		if home == "" {
			return ""
		}
		root = filepath.Join(home, ".config")
	}
	if !filepath.IsAbs(root) {
		return ""
	}
	return filepath.Join(root, kind.name())
}

// requireManagedRegistration refuses a managed launch only on a positive
// finding that a plugin list group holds no entry of ours. Unknown proceeds:
// native may accept what this reader does not.
func requireManagedRegistration(kind nativeKind, label string, environment []string) error {
	directory := nativeGlobalConfigDirectory(kind, environment)
	if directory == "" {
		return nil
	}
	server, tui := managedRegistration(kind, directory)
	var missing []string
	if server == registrationAbsent {
		missing = append(missing, "server")
	}
	if tui == registrationAbsent {
		missing = append(missing, "TUI")
	}
	if len(missing) == 0 {
		return nil
	}
	message := fmt.Sprintf("%s Sessionbus plugin is not in the %s plugin list of %s, which a managed launch requires", label, strings.Join(missing, " and "), directory)
	if command := restoreCommand(kind); command != "" {
		return errors.New(message + "; register it with: " + command)
	}
	return errors.New(message + "; run the " + kind.name() + "-peer installer again")
}

// restoreCommand is the installer's own registration call for this installed
// executable, or empty when the plugin package is not next to it.
func restoreCommand(kind nativeKind) string {
	executable, err := os.Executable()
	if err == nil {
		executable, err = filepath.EvalSymlinks(executable)
	}
	if err != nil {
		return ""
	}
	plugin := filepath.Join(filepath.Dir(executable), "plugin")
	if name, known := directoryPackageName(plugin, plugin); !known || name != kind.installPackage() {
		return ""
	}
	return shellQuote(executable) + " --sessionbus-install --plugin-dir " + shellQuote(plugin)
}

func shellQuote(text string) string {
	return "'" + strings.ReplaceAll(text, "'", `'\''`) + "'"
}

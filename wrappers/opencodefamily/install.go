// SPDX-License-Identifier: MIT

package opencodefamily

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// InstallOptions configures only owned native plugin entries. Directory is the
// native global config directory, not an alternate native runtime configuration.
type InstallOptions struct {
	Directory string
	Specifier string
	Remove    bool
}

type configDocument struct {
	kind           nativeKind
	file, physical string
	body           []byte
	mode           os.FileMode
	info           os.FileInfo
	tree           *configNode
	tui            bool
	selected       bool
}

type configChange struct {
	doc        *configDocument
	body       []byte
	removeFile bool
}

// ConfigureOpenCodePlugin reconciles both native global server and TUI registrations.
// Every existing merged file is parsed before any file is changed.
func ConfigureOpenCodePlugin(options InstallOptions) (bool, error) {
	return configurePlugin(options, commitConfigChanges)
}

func ConfigureKiloPlugin(options InstallOptions) (bool, error) {
	return configurePluginFor(kiloNative, options, commitConfigChanges)
}

func configurePlugin(options InstallOptions, commit func([]configChange) error) (bool, error) {
	return configurePluginFor(openCodeNative, options, commit)
}

func configurePluginFor(kind nativeKind, options InstallOptions, commit func([]configChange) error) (bool, error) {
	if options.Directory == "" {
		root := os.Getenv("XDG_CONFIG_HOME")
		if root == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return false, err
			}
			root = filepath.Join(home, ".config")
		}
		options.Directory = filepath.Join(root, kind.name())
	}
	if !options.Remove && (!validInstallText(options.Specifier) || !installableSpecifier(kind, options.Specifier, options.Directory)) {
		return false, fmt.Errorf("specifier is not an installable %s package", kind.installPackage())
	}
	skillRoot, err := packageSkillRoot(kind, options)
	if err != nil {
		return false, err
	}
	groups := kind.installConfigNames()
	var changes []configChange
	var identities []os.FileInfo
	for group, names := range groups {
		var docs []*configDocument
		for _, name := range names {
			file := filepath.Join(options.Directory, name)
			doc, err := readConfigDocument(file)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return false, err
			}
			for _, identity := range identities {
				if os.SameFile(identity, doc.info) {
					return false, errors.New("native config files alias the same physical file")
				}
			}
			identities = append(identities, doc.info)
			doc.kind = kind
			doc.tui = group == 1
			docs = append(docs, doc)
		}
		if len(docs) == 0 {
			if options.Remove {
				continue
			}
			file := filepath.Join(options.Directory, names[0])
			tree, _ := parseConfig([]byte("{}\n"))
			docs = append(docs, &configDocument{kind: kind, file: file, physical: file, body: []byte("{}\n"), mode: 0o600, tree: tree, tui: group == 1})
		}
		docs[0].selected = true
		owned, exact := 0, false
		for _, doc := range docs {
			targets, err := configPluginTargets(doc)
			if err != nil {
				return false, err
			}
			for index, target := range targets {
				plugin, err := target.property("plugin")
				if err != nil {
					return false, fmt.Errorf("%s: %w", doc.file, err)
				}
				if plugin == nil {
					continue
				}
				if plugin.kind != '[' {
					return false, fmt.Errorf("%s: plugin must be an array", doc.file)
				}
				for _, entry := range plugin.items {
					spec, err := configEntrySpecifier(entry)
					if err != nil {
						return false, fmt.Errorf("%s: %w", doc.file, err)
					}
					if ownedInstallSpecifier(kind, spec, doc.file) {
						owned++
						exact = doc.selected && index == len(targets)-1 && entry.kind == '"' && spec == options.Specifier
					}
				}
			}
		}
		var skillDoc *configDocument
		if group == 0 {
			var err error
			skillDoc, err = skillTarget(kind, docs)
			if err != nil {
				return false, err
			}
		}
		pluginUnchanged := options.Remove && owned == 0 || !options.Remove && owned == 1 && exact
		for _, doc := range docs {
			body := doc.body
			var err error
			if !pluginUnchanged {
				body, err = editPluginConfig(doc, options.Specifier, options.Remove)
			}
			if err != nil {
				return false, fmt.Errorf("%s: %w", doc.file, err)
			}
			if group == 0 {
				updated := *doc
				updated.body = body
				updated.tree, err = parseConfig(body)
				if err == nil {
					body, err = editSkillConfig(&updated, skillRoot, doc == skillDoc)
				}
				if err != nil {
					return false, fmt.Errorf("%s: %w", doc.file, err)
				}
			}
			if !bytes.Equal(body, doc.body) {
				changes = append(changes, configChange{doc: doc, body: body})
			}
		}
	}
	if kind == kiloNative {
		legacy, err := readKiloLegacyEntry(options.Directory)
		if err != nil {
			return false, err
		}
		if legacy != nil {
			for _, identity := range identities {
				if os.SameFile(identity, legacy.info) {
					return false, errors.New("legacy plugin aliases native config")
				}
			}
			changes = append(changes, configChange{doc: legacy, removeFile: true})
		}
	}
	if len(changes) == 0 {
		return false, nil
	}
	return true, commit(changes)
}

func readInstallFile(file string) ([]byte, os.FileInfo, error) {
	fd, err := unix.Open(file, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, err
	}
	f := os.NewFile(uintptr(fd), file)
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxInstallConfig {
		return nil, nil, fmt.Errorf("%s: expected regular file no larger than 1 MiB", file)
	}
	body, err := io.ReadAll(io.LimitReader(f, maxInstallConfig+1))
	if err != nil {
		return nil, nil, err
	}
	if len(body) > maxInstallConfig {
		return nil, nil, errors.New("configuration grew beyond 1 MiB")
	}
	return body, info, nil
}

func readConfigDocument(file string) (*configDocument, error) {
	body, info, err := readInstallFile(file)
	if err != nil {
		return nil, err
	}
	physical, err := filepath.EvalSymlinks(file)
	if err != nil {
		return nil, err
	}
	physical, err = filepath.Abs(physical)
	if err != nil {
		return nil, err
	}
	actual, err := os.Stat(physical)
	if err != nil || !os.SameFile(info, actual) {
		return nil, fmt.Errorf("%s: configuration identity changed while opening", file)
	}
	tree, err := parseConfig(body)
	if err != nil {
		return nil, fmt.Errorf("%s: not valid JSONC: %w", file, err)
	}
	return &configDocument{file: file, physical: physical, body: body, info: info, mode: info.Mode().Perm(), tree: tree}, nil
}

func validInstallText(value string) bool {
	return value != "" && len(value) <= maxInstallConfig && !strings.ContainsAny(value, "\x00\r\n")
}

func ownedInstallSpecifier(kind nativeKind, spec, configFile string) bool {
	pkg := kind.installPackage()
	archive := "sessionbus-" + kind.name() + "-"
	if spec == pkg || strings.HasPrefix(spec, pkg+"@") && !strings.ContainsAny(spec, " \t\r\n") && len(spec) > len(pkg+"@") {
		return true
	}
	clean := specifierLocation(spec)
	if clean == "" {
		return false
	}
	name := filepath.Base(clean)
	if strings.HasPrefix(name, archive) && strings.HasSuffix(name, ".tgz") && len(name) > len(archive+".tgz") {
		return true
	}
	if !strings.HasPrefix(clean, "file:") {
		return false
	}
	manifest, known := filePackageName(clean, configFile)
	return known && manifest == pkg
}

// specifierLocation is a specifier without its query or fragment, with
// forward slashes. Empty means the specifier has no location part.
func specifierLocation(spec string) string {
	location := strings.FieldsFunc(spec, func(r rune) bool { return r == '?' || r == '#' })
	if len(location) == 0 {
		return ""
	}
	return strings.ReplaceAll(location[0], "\\", "/")
}

// filePackageName returns the manifest name of the local package a file:
// location points at. known is false when the location is not a local file URL
// or its manifest cannot be read or parsed.
func filePackageName(location, configFile string) (name string, known bool) {
	u, err := url.Parse(location)
	if err != nil || u.Host != "" && u.Host != "localhost" {
		return "", false
	}
	target := u.Path
	if u.Opaque != "" {
		target = u.Opaque
	}
	return directoryPackageName(target, configFile)
}

// directoryPackageName reads <target>/package.json; a relative target is
// relative to the config file that names it.
func directoryPackageName(target, configFile string) (name string, known bool) {
	if !filepath.IsAbs(target) {
		target = filepath.Join(filepath.Dir(configFile), target)
	}
	body, _, err := readInstallFile(filepath.Join(target, "package.json"))
	var manifest struct {
		Name string `json:"name"`
	}
	if err != nil || json.Unmarshal(body, &manifest) != nil {
		return "", false
	}
	return manifest.Name, true
}

func installableSpecifier(kind nativeKind, spec, directory string) bool {
	return (strings.HasPrefix(spec, kind.installPackage()) || strings.HasPrefix(spec, "file:") || strings.HasPrefix(spec, "https://") || strings.HasPrefix(spec, "http://")) && ownedInstallSpecifier(kind, spec, filepath.Join(directory, kind.name()+".jsonc"))
}

func configEntrySpecifier(entry *configNode) (string, error) {
	if entry.kind == '[' && len(entry.items) == 2 {
		entry = entry.items[0]
	}
	if entry.kind != '"' || !validInstallText(entry.text) {
		return "", errors.New("plugin requires strings or [string, options] tuples")
	}
	return entry.text, nil
}

func configPluginTargets(doc *configDocument) ([]*configNode, error) {
	result := []*configNode{doc.tree}
	if doc.tui {
		nested, err := doc.tree.property("tui")
		if err != nil {
			return nil, err
		}
		if nested != nil && nested.kind == '{' {
			result = append(result, nested)
		}
	}
	return result, nil
}

func editPluginConfig(doc *configDocument, spec string, remove bool) ([]byte, error) {
	targets, err := configPluginTargets(doc)
	if err != nil {
		return nil, err
	}
	var edits []configEdit
	for index, target := range targets {
		add := !remove && doc.selected && index == len(targets)-1
		plugin, err := target.property("plugin")
		if err != nil {
			return nil, err
		}
		encoded, _ := json.Marshal(spec)
		if plugin == nil {
			if add {
				text := append([]byte(`"plugin":[`), encoded...)
				text = append(text, ']')
				if len(target.items) > 0 && target.commas[len(target.commas)-1] < 0 {
					text = append([]byte{','}, text...)
				}
				edits = append(edits, configEdit{target.end - 1, target.end - 1, text})
			}
			continue
		}
		last := -1
		for i, entry := range plugin.items {
			value, err := configEntrySpecifier(entry)
			if err != nil {
				return nil, err
			}
			if ownedInstallSpecifier(doc.kind, value, doc.file) {
				edits = append(edits, configEdit{entry.start, entry.end, nil})
				if plugin.commas[i] >= 0 {
					edits = append(edits, configEdit{plugin.commas[i], plugin.commas[i] + 1, nil})
				}
			} else {
				last = i
			}
		}
		if add {
			if last >= 0 && plugin.commas[last] < 0 {
				encoded = append([]byte{','}, encoded...)
			}
			edits = append(edits, configEdit{plugin.end - 1, plugin.end - 1, encoded})
		}
	}
	return applyConfigEdits(doc.body, edits)
}

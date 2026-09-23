// SPDX-License-Identifier: MIT

package opencodefamily

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/sessionbus/peer-common/host"
)

var openCodeInteractiveValueOptions = []string{"--log-level", "--port", "--hostname", "--mdns-domain", "--cors", "-m", "--model", "-s", "--session", "--prompt", "--agent", "--replay-limit"}

var kiloInteractiveValueOptions = []string{"--log-level", "--port", "--hostname", "--mdns-domain", "--mdnsDomain", "--cors", "-m", "--model", "-s", "--session", "--prompt", "--agent", "--worktree", "--replay-limit", "--replayLimit"}

func KiloInteractiveValueOptions() []string { return slices.Clone(kiloInteractiveValueOptions) }

// OpenCodeInteractiveValueOptions returns the fixed native options that consume
// one argument in the managed front door. Callers cannot alter the shared list.
func OpenCodeInteractiveValueOptions() []string { return slices.Clone(openCodeInteractiveValueOptions) }

// Native Effect4 Config.boolean is case-sensitive and does not trim: true,
// yes, on, 1, y are true; false, no, off, 0, n are false. Malformed values are
// left intact for the native parser rather than silently treated as false.
func ValidateOpenCodeTopology(arguments, environment []string) error {
	return validateNativeTopology(arguments, environment, false)
}
func ValidateKiloTopology(arguments, environment []string) error {
	return validateNativeTopology(arguments, environment, true)
}
func validateNativeTopology(arguments, environment []string, kilo bool) error {
	product, label, pure, values := "opencode", "OpenCode", "OPENCODE_PURE", openCodeInteractiveValueOptions
	if kilo {
		product, label, pure, values = "kilo", "Kilo", "KILO_PURE", kiloInteractiveValueOptions
	}
	value := InteractiveEnvironmentValue(environment, pure)
	// Kilo TUI's truthy getter lowercases true/1, while its server retains the
	// exact Effect boolean grammar. Reject either enabling interpretation;
	// leave other malformed environment values intact for native validation.
	if slices.Contains([]string{"true", "yes", "on", "1", "y"}, value) || kilo && strings.ToLower(value) == "true" {
		return fmt.Errorf("%s disables the required managed %s plugins", pure, label)
	}
	for index := 0; index < len(arguments); index++ {
		if arguments[index] == "--" {
			break
		}
		key, value, attached := strings.Cut(arguments[index], "=")
		switch key {
		case "--hostname", "--port", "--mdns", "--no-mdns", "--mdns-domain", "--mdnsDomain", "--cors":
			return fmt.Errorf("%s-peer owns native loopback HTTP topology; %s conflicts", product, key)
		case "--pure":
			if attached && value == "false" {
				continue
			}
			if !attached && index+1 < len(arguments) && arguments[index+1] == "false" {
				index++
				continue
			}
			return fmt.Errorf("--pure disables the required managed %s plugins (only explicit false is compatible)", label)
		case "--mini":
			if !kilo {
				break
			}
			if attached && value == "false" {
				continue
			}
			if !attached && index+1 < len(arguments) && arguments[index+1] == "false" {
				index++
				continue
			}
			return errors.New("--mini is incompatible with the managed Kilo TUI plugin and loopback topology")
		case "--no-mini":
			if kilo && attached {
				return errors.New("--no-mini takes no assigned value in managed mode")
			}
		case "--no-pure":
			if attached {
				return errors.New("--no-pure takes no assigned value in managed mode")
			}
		}
		if slices.Contains(values, key) && !attached {
			index++
		}
	}
	return nil
}

func InteractiveEnvironmentValue(environment []string, key string) string {
	for i := len(environment) - 1; i >= 0; i-- {
		if value, ok := strings.CutPrefix(environment[i], key+"="); ok {
			return value
		}
	}
	return ""
}

func setInteractiveEnvironment(environment []string, key, value string) []string {
	result := make([]string, 0, len(environment)+1)
	for _, entry := range environment {
		if !strings.HasPrefix(entry, key+"=") {
			result = append(result, entry)
		}
	}
	return append(result, key+"="+value)
}

func NormalizeInteractiveIdentity(environment []string) ([]string, error) {
	raw := InteractiveEnvironmentValue(environment, host.GroupsEnv)
	if len(raw) > 64*1024 {
		return nil, errors.New("managed groups exceed 64 KiB")
	}
	var values []string
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil, err
	}
	groups := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		for _, group := range strings.Split(value, ",") {
			group = strings.TrimSpace(group)
			if group == "" || strings.ContainsRune(group, 0) {
				return nil, errors.New("managed groups require nonempty names")
			}
			if !seen[group] {
				groups = append(groups, group)
				seen[group] = true
			}
		}
	}
	name := InteractiveEnvironmentValue(environment, host.NameEnv)
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) > 128 || strings.ContainsFunc(name, func(r rune) bool { return !unicode.IsGraphic(r) }) {
		return nil, errors.New("managed name must be at most 128 printable characters")
	}
	encoded, _ := json.Marshal(groups)
	return setInteractiveEnvironment(environment, host.GroupsEnv, string(encoded)), nil
}

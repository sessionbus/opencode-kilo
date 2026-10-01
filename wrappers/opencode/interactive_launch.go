// SPDX-License-Identifier: MIT

package opencode

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"

	"github.com/sessionbus/opencode-kilo/wrappers/opencodefamily"
	"github.com/sessionbus/peer-common/host"
)

// LaunchEnv carries one managed launch's Sessionbus selection to the native
// TUI plugin. The plugin activates only in the process with this PID: exec
// keeps it, while children of the shared native service inherit the variable
// from whichever TUI started that service and never match.
const LaunchEnv = "SESSIONBUS_OPENCODE_LAUNCH"

type launchBinding struct {
	PID    int      `json:"pid"`
	Socket string   `json:"socket"`
	Name   string   `json:"name,omitempty"`
	Groups []string `json:"groups"`
	// Create asks the TUI for a session of its own: the launch selects none
	// (no prompt, -s or -c), so it would otherwise wait unreachable on home.
	Create bool `json:"create,omitempty"`
}

// ExecInteractive replaces this process with the native OpenCode TUI. The
// background service and the plugin own everything after exec.
func ExecInteractive(plan host.ExecPlan) error {
	path, err := exec.LookPath(plan.Path)
	if err != nil {
		return err
	}
	value := func(key string) string { return opencodefamily.InteractiveEnvironmentValue(plan.Env, key) }
	if !filepath.IsAbs(value(host.SocketEnv)) {
		return errors.New("managed Sessionbus socket must be absolute")
	}
	if value(host.LocalKeyEnv) != "" {
		return errors.New("local key transport is not supported")
	}
	binding := launchBinding{PID: os.Getpid(), Socket: value(host.SocketEnv), Name: value(host.NameEnv), Create: !selectsSession(plan.Args)}
	if err := json.Unmarshal([]byte(value(host.GroupsEnv)), &binding.Groups); err != nil {
		return err
	}
	encoded, err := json.Marshal(binding)
	if err != nil {
		return err
	}
	environment := slices.DeleteFunc(slices.Clone(plan.Env), func(entry string) bool { return strings.HasPrefix(entry, "SESSIONBUS_") })
	environment = append(environment, LaunchEnv+"="+string(encoded))
	return syscall.Exec(path, append([]string{path}, plan.Args...), environment)
}

// selectsSession reports whether native argv already opens or submits to a
// session: --prompt, -s/--session or -c/--continue, before the literal "--".
func selectsSession(arguments []string) bool {
	for _, argument := range arguments {
		if argument == "--" {
			return false
		}
		name, _, _ := strings.Cut(argument, "=")
		switch name {
		case "--prompt", "-s", "--session", "-c", "--continue":
			return true
		}
	}
	return false
}

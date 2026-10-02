// SPDX-License-Identifier: MIT

package opencode

import (
	"slices"
	"strings"

	sessionkit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/sessionbus/opencode-kilo/wrappers/opencodefamily"
	"github.com/sessionbus/peer-common/host"
)

var interactiveValueOptions = opencodefamily.OpenCodeInteractiveValueOptions()

// OpenCode v2 top-level subcommands run natively with their argv untouched.
var passthroughCommands = []string{"upgrade", "update", "uninstall", "acp", "api", "debug", "auth", "mcp", "plugin", "models", "stats", "mini", "run", "session", "service", "reload", "pair", "serve"}

func resumeAlias(arguments []string) ([]string, error) {
	return opencodefamily.OpenCodeResumeAlias(arguments)
}

func InteractivePlan(arguments, environment []string) (host.ExecPlan, bool, error) {
	positional := false
	aliased, aliasErr := resumeAlias(arguments)
	if aliasErr != nil {
		// A native subcommand or help request keeps its argv untouched.
		aliased = arguments
	}
	plan, native, err := host.ClassifiedInteractivePlan("opencode", aliased, environment, host.PeerIdentity{}, func(value string) bool {
		return slices.Contains(interactiveValueOptions, value)
	}, func(value string) bool {
		if value == "-h" || value == "--help" || value == "-v" || value == "--version" {
			return true
		}
		if strings.HasPrefix(value, "-") || positional {
			return false
		}
		positional = true
		return slices.Contains(passthroughCommands, value)
	})
	if native {
		return host.ExecPlan{Path: plan.Path, Args: arguments, Env: plan.Env}, true, err
	}
	if err != nil {
		return plan, native, err
	}
	if aliasErr != nil {
		return host.ExecPlan{}, false, aliasErr
	}
	plan.Args = sharedServiceArguments(plan.Args)
	plan.Env, err = normalizeManagedIdentity(plan.Env)
	if err != nil {
		return host.ExecPlan{}, false, err
	}
	if !slices.ContainsFunc(plan.Env, func(value string) bool { return strings.HasPrefix(value, host.SocketEnv+"=") }) {
		plan.Env = append(plan.Env, host.SocketEnv+"="+sessionkit.Socket())
	}
	return plan, false, nil
}

// A managed launch always uses the user's shared OpenCode service (owner,
// 2026-10-02: strip and launch). --standalone and --server would start or pick
// another server, so they are dropped before `--`; another option's value and
// everything after `--` stay as given.
func sharedServiceArguments(arguments []string) []string {
	kept := make([]string, 0, len(arguments))
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		switch {
		case argument == "--":
			return append(kept, arguments[index:]...)
		case argument == "--standalone", strings.HasPrefix(argument, "--standalone="), strings.HasPrefix(argument, "--server="):
			continue
		case argument == "--server":
			index++ // and its value, when there is one
			continue
		}
		kept = append(kept, argument)
		if slices.Contains(interactiveValueOptions, argument) && index+1 < len(arguments) {
			index++
			kept = append(kept, arguments[index])
		}
	}
	return kept
}

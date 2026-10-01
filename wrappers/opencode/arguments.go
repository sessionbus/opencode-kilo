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
	plan.Env, err = normalizeManagedIdentity(plan.Env)
	if err != nil {
		return host.ExecPlan{}, false, err
	}
	if !slices.ContainsFunc(plan.Env, func(value string) bool { return strings.HasPrefix(value, host.SocketEnv+"=") }) {
		plan.Env = append(plan.Env, host.SocketEnv+"="+sessionkit.Socket())
	}
	return plan, false, nil
}

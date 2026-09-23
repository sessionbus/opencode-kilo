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
var passthroughCommands = []string{"completion", "acp", "mcp", "attach", "run", "debug", "providers", "agent", "upgrade", "uninstall", "serve", "web", "models", "stats", "export", "import", "github", "pr", "session", "plugin", "db"}

func resumeAlias(arguments []string) ([]string, error) {
	return opencodefamily.OpenCodeResumeAlias(arguments)
}

func InteractivePlan(arguments, environment []string) (host.ExecPlan, bool, error) {
	positional := false
	pureBooleanValue := false
	aliased, aliasErr := resumeAlias(arguments)
	if aliasErr != nil {
		// A native subcommand or help request keeps its argv untouched.
		aliased = arguments
	}
	plan, native, err := host.ClassifiedInteractivePlan("opencode", aliased, environment, host.PeerIdentity{}, func(value string) bool {
		return slices.Contains(interactiveValueOptions, value)
	}, func(value string) bool {
		if pureBooleanValue {
			pureBooleanValue = false
			if value == "true" || value == "false" {
				return false
			}
		}
		if value == "--pure" {
			pureBooleanValue = true
		}
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
	if err := validateManagedTopology(plan.Args, plan.Env); err != nil {
		return host.ExecPlan{}, false, err
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

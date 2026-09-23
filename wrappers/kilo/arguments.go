// SPDX-License-Identifier: MIT

package kilo

import (
	"slices"
	"strings"

	sessionkit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/sessionbus/opencode-kilo/wrappers/opencodefamily"
	"github.com/sessionbus/peer-common/host"
)

var interactiveValueOptions = opencodefamily.KiloInteractiveValueOptions()

// Native 7.6.2 index.ts plus kilocode/cli/setup.ts and lazy command declarations.
var passthroughCommands = []string{"completion", "acp", "mcp", "attach", "run", "generate", "debug", "auth", "providers", "agent", "upgrade", "uninstall", "serve", "models", "stats", "export", "import", "github", "pr", "session", "plugin", "plug", "db", "console", "cloud", "roll-call", "profile", "remote", "daemon", "config", "worktree", "help", "__pty-smoke", "dev-setup", "dev-alias"}
var nativeBooleanOptions = []string{"--pure", "--mini", "--continue", "-c", "--fork", "--cloud-fork", "--cloudFork", "--auto", "--yolo", "--dangerously-skip-permissions", "--dangerouslySkipPermissions", "--replay", "--demo", "--print-logs", "--printLogs"}

// InteractivePlan classifies native passthrough before resolving any managed
// executable or injecting topology. Native arguments after -- remain literal.
func InteractivePlan(arguments, environment []string) (host.ExecPlan, bool, error) {
	positional, booleanValue := false, false
	aliased, aliasErr := opencodefamily.KiloResumeAlias(arguments)
	if aliasErr != nil {
		aliased = arguments
	}
	plan, native, err := host.ClassifiedInteractivePlan("kilo", aliased, environment, host.PeerIdentity{}, func(value string) bool {
		return slices.Contains(interactiveValueOptions, value)
	}, func(value string) bool {
		if booleanValue {
			booleanValue = false
			if value == "true" || value == "false" {
				return false
			}
		}
		if slices.Contains(nativeBooleanOptions, value) {
			booleanValue = true
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
	if err := opencodefamily.ValidateKiloTopology(plan.Args, plan.Env); err != nil {
		return host.ExecPlan{}, false, err
	}
	plan.Env, err = opencodefamily.NormalizeInteractiveIdentity(plan.Env)
	if err != nil {
		return host.ExecPlan{}, false, err
	}
	if !slices.ContainsFunc(plan.Env, func(value string) bool { return strings.HasPrefix(value, host.SocketEnv+"=") }) {
		plan.Env = append(plan.Env, host.SocketEnv+"="+sessionkit.Socket())
	}
	return plan, false, nil
}

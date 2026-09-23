// SPDX-License-Identifier: MIT

package kilo

import (
	"context"
	"github.com/sessionbus/opencode-kilo/wrappers/opencodefamily"
	"github.com/sessionbus/peer-common/host"
)

const InteractiveLaunchEnv = opencodefamily.KiloInteractiveLaunchEnv

// RunInteractive selects the direct native binary and native resource layout
// before handing its lifetime to the shared launcher. No Node shim is spawned.
func RunInteractive(ctx context.Context, plan host.ExecPlan) error {
	if err := opencodefamily.ValidateKiloTopology(plan.Args, plan.Env); err != nil {
		return err
	}
	native, err := ResolveNativeExecutable(plan.Path)
	if err != nil {
		return err
	}
	plan.Path, plan.Env = native.Path, native.Environment(plan.Env)
	return opencodefamily.RunKiloInteractive(ctx, plan)
}

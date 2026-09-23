// SPDX-License-Identifier: MIT

package opencode

import (
	"context"
	"github.com/sessionbus/opencode-kilo/wrappers/opencodefamily"
	"github.com/sessionbus/peer-common/host"
)

const InteractiveLaunchEnv = opencodefamily.OpenCodeInteractiveLaunchEnv

type interactiveLaunchBinding = opencodefamily.InteractiveLaunchBinding

// RunInteractive keeps the existing OpenCode entry over the shared native lifetime.
func RunInteractive(ctx context.Context, plan host.ExecPlan) error {
	return opencodefamily.RunOpenCodeInteractive(ctx, plan)
}

// SPDX-License-Identifier: MIT
package opencode

import "github.com/sessionbus/opencode-kilo/wrappers/opencodefamily"

const (
	Product       = opencodefamily.Product
	ToolName      = opencodefamily.ToolName
	LaneSocketEnv = opencodefamily.LaneSocketEnv
)

// Wrapper retains the OpenCode lane API while sharing its native-family engine.
type Wrapper = opencodefamily.Wrapper

func New(socket, provisional, executable string) *Wrapper {
	return opencodefamily.NewOpenCode(socket, provisional, executable)
}

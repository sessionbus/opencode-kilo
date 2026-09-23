// SPDX-License-Identifier: MIT
package kilo

import "github.com/sessionbus/opencode-kilo/wrappers/opencodefamily"

const (
	Product       = "kilo-peer"
	ToolName      = opencodefamily.ToolName
	LaneSocketEnv = opencodefamily.LaneSocketEnv
)

type Wrapper = opencodefamily.Wrapper

func New(socket, provisional, executable string) *Wrapper {
	return opencodefamily.NewKilo(socket, provisional, executable)
}

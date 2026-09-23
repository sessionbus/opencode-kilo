// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"testing"

	"github.com/sessionbus/peer-common/host"
)

func TestLaneModeRejectsArguments(t *testing.T) {
	t.Setenv(host.TokenEnv, "token")
	if err := run(context.Background(), []string{"mcp"}); err == nil || err.Error() != "lane mode accepts no arguments" {
		t.Fatalf("run = %v", err)
	}
}

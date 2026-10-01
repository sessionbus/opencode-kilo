// SPDX-License-Identifier: MIT
package opencode

import (
	sessionkit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/sessionbus/peer-common/host"
	"slices"
	"testing"
)

func TestInteractiveArity(t *testing.T) {
	// A native value option keeps its next token, even one that looks like ours.
	plan, native, err := InteractivePlan([]string{"--prompt", "-g", "team"}, []string{"PATH=/bin"})
	if err != nil || native || !slices.Equal(plan.Args, []string{"--prompt", "-g", "team"}) {
		t.Fatalf("arity plan = %#v/%v/%v", plan, native, err)
	}
	if !slices.Contains(plan.Env, host.SocketEnv+"="+sessionkit.Socket()) {
		t.Fatalf("default socket missing from %#v", plan.Env)
	}
	plan, native, err = InteractivePlan([]string{"run", "-g"}, []string{"PATH=/bin"})
	if err != nil || !native || !slices.Equal(plan.Args, []string{"run", "-g"}) {
		t.Fatalf("passthrough = %#v/%v/%v", plan, native, err)
	}
	plan, native, err = InteractivePlan([]string{"/work/project", "run", "-g", "team"}, []string{"PATH=/bin"})
	if err != nil || native || !slices.Equal(plan.Args, []string{"/work/project", "run"}) {
		t.Fatalf("project = %#v/%v/%v", plan, native, err)
	}
	plan, native, err = InteractivePlan([]string{"--server", "service", "-c"}, nil)
	if err != nil || native || !slices.Equal(plan.Args, []string{"--server", "service", "-c"}) {
		t.Fatalf("native server value = %#v/%v/%v", plan, native, err)
	}
	// A global value flag's value is never the native subcommand of the same
	// name ("debug"), in either spelling.
	for _, args := range [][]string{{"--log-level", "debug", "-g", "team"}, {"--log-level=debug", "-g", "team"}, {"--completions", "bash", "-g", "team"}} {
		plan, native, err = InteractivePlan(args, []string{"PATH=/bin"})
		if err != nil || native || !slices.Equal(plan.Args, args[:len(args)-2]) || !slices.Contains(plan.Env, host.GroupsEnv+`=["team"]`) {
			t.Fatalf("global value flag %v = %#v/%v/%v", args, plan, native, err)
		}
	}
}

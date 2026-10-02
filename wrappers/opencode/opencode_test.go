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
	// The --server value is not the "service" subcommand; the flag itself is
	// dropped for the shared service.
	plan, native, err = InteractivePlan([]string{"--server", "service", "-c"}, nil)
	if err != nil || native || !slices.Equal(plan.Args, []string{"-c"}) {
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

// A managed launch drops --standalone and --server (with its value) before
// `--`, and nothing else; native subcommands keep their arguments.
func TestManagedLaunchUsesSharedService(t *testing.T) {
	for _, tc := range []struct{ in, args []string }{
		{[]string{"--standalone", "-g", "team"}, nil},
		{[]string{"--standalone=true", "-c"}, []string{"-c"}},
		{[]string{"--server", "http://127.0.0.1:1", "-c"}, []string{"-c"}},
		{[]string{"--server=http://127.0.0.1:1", "/work"}, []string{"/work"}},
		{[]string{"-c", "--server"}, []string{"-c"}},
		{[]string{"--prompt", "--standalone"}, []string{"--prompt", "--standalone"}},
		{[]string{"-s", "--server", "--standalone"}, []string{"-s", "--server"}},
		{[]string{"--log-level", "debug", "--", "--standalone", "--server", "x"}, []string{"--log-level", "debug", "--", "--standalone", "--server", "x"}},
		{[]string{"--resume", "ses_x", "--standalone"}, []string{"-s", "ses_x"}},
		{[]string{"-c", "--prompt", "hi"}, []string{"-c", "--prompt", "hi"}},
	} {
		plan, native, err := InteractivePlan(tc.in, []string{"PATH=/bin"})
		if err != nil || native || !slices.Equal(plan.Args, tc.args) {
			t.Fatalf("%v = %#v/%v/%v, want args %v", tc.in, plan.Args, native, err, tc.args)
		}
	}
	plan, native, err := InteractivePlan([]string{"serve", "--server", "x", "--standalone"}, nil)
	if err != nil || !native || !slices.Equal(plan.Args, []string{"serve", "--server", "x", "--standalone"}) {
		t.Fatalf("passthrough = %#v/%v/%v", plan, native, err)
	}
}

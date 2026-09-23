// SPDX-License-Identifier: MIT
package opencode

import (
	sessionkit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/sessionbus/peer-common/host"
	"slices"
	"testing"
)

func TestInteractiveArity(t *testing.T) {
	plan, native, err := InteractivePlan([]string{"--log-level", "-g", "team"}, []string{"PATH=/bin"})
	if err != nil || native || !slices.Equal(plan.Args, []string{"--log-level", "-g", "team"}) {
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
	if _, _, err = InteractivePlan([]string{"--pure=true"}, nil); err == nil {
		t.Fatal("--pure accepted")
	}
	plan, native, err = InteractivePlan([]string{"--log-level", "--pure"}, nil)
	if err != nil || native || !slices.Equal(plan.Args, []string{"--log-level", "--pure"}) {
		t.Fatalf("native pure value = %#v/%v/%v", plan, native, err)
	}
}

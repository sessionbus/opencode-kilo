// SPDX-License-Identifier: MIT

package opencode

import (
	"slices"
	"strings"
	"testing"

	"github.com/sessionbus/peer-common/host"
)

func TestManagedGroupsAndNativeSelectorPreservation(t *testing.T) {
	args := []string{"--session", "ses_exact", "-g", "a,b", "--group=c,a", "-n", "literal name", "--fork", "--", "-g", "native"}
	plan, native, err := InteractivePlan(args, nil)
	if err != nil || native {
		t.Fatal(err)
	}
	if !slices.Equal(plan.Args, []string{"--session", "ses_exact", "--fork", "--", "-g", "native"}) {
		t.Fatal(plan.Args)
	}
	if interactiveEnv(plan.Env, host.GroupsEnv) != `["a","b","c"]` || interactiveEnv(plan.Env, host.NameEnv) != "literal name" {
		t.Fatal(plan.Env)
	}
	if interactiveEnv(plan.Env, host.SessionIDEnv) != "" {
		t.Fatal("invented native ID")
	}
	for _, args := range [][]string{{"-g", "a,,b"}, {"-n", strings.Repeat("x", 129)}} {
		if _, _, err := InteractivePlan(args, nil); err == nil {
			t.Fatal("invalid identity accepted", args)
		}
	}
}

func TestResumeAliasBecomesNativeSessionInPlace(t *testing.T) {
	for _, tc := range []struct{ in, want []string }{
		{[]string{"--resume", "ses_a", "--agent", "build"}, []string{"-s", "ses_a", "--agent", "build"}},
		{[]string{"--agent", "build", "--resume=ses_a"}, []string{"--agent", "build", "-s", "ses_a"}},
		{[]string{"-g", "one", "--resume", "ses_a", "-n", "named", "--", "--resume", "literal"}, []string{"-s", "ses_a", "--", "--resume", "literal"}},
		{[]string{"--session", "ses_native", "--resume", "ses_a"}, []string{"--session", "ses_native", "-s", "ses_a"}},
		{[]string{"--", "--resume=ses_a"}, []string{"--", "--resume=ses_a"}},
		{[]string{"-n", "--resume", "--resume", "ses_a"}, []string{"-s", "ses_a"}},
		{[]string{"--group", "--resume", "-s", "--resume", "--resume=ses_a"}, []string{"-s", "--resume", "-s", "ses_a"}},
	} {
		plan, native, err := InteractivePlan(tc.in, nil)
		if err != nil || native || !slices.Equal(plan.Args, tc.want) {
			t.Fatalf("%v: got %v native=%v err=%v, want %v", tc.in, plan.Args, native, err, tc.want)
		}
	}
	for _, args := range [][]string{{"--resume"}, {"--resume", ""}, {"--resume", " "}, {"--resume="}, {"--resume", "--", "x"}} {
		if _, _, err := InteractivePlan(args, nil); err == nil || !strings.Contains(err.Error(), "--resume") {
			t.Fatalf("%v: expected --resume value error, got %v", args, err)
		}
	}
	for _, args := range [][]string{{"run", "--resume", "x"}, {"--resume", "x", "run"}, {"--help", "--resume"}} {
		plan, native, err := InteractivePlan(args, nil)
		if err != nil || !native || !slices.Equal(plan.Args, args) {
			t.Fatalf("%v: native passthrough must keep argv verbatim, got %v native=%v err=%v", args, plan.Args, native, err)
		}
	}
}

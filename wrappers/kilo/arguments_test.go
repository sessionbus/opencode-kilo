// SPDX-License-Identifier: MIT

package kilo

import (
	"github.com/sessionbus/opencode-kilo/wrappers/opencodefamily"
	"github.com/sessionbus/peer-common/host"
	"slices"
	"strings"
	"testing"
)

func TestKiloManagedTopologyAndBothPureGrammars(t *testing.T) {
	for _, args := range [][]string{{"--hostname=x"}, {"--port", "1"}, {"--mdns=false"}, {"--no-mdns"}, {"--mdnsDomain=x"}, {"--cors=x"}, {"--pure"}, {"--pure=true"}, {"--pure=bad"}, {"--mini"}, {"--mini=true"}, {"--mini=bad"}, {"--no-mini=false"}, {"--no-pure=true"}} {
		if _, _, err := InteractivePlan(args, nil); err == nil {
			t.Fatalf("accepted conflict %v", args)
		}
	}
	for _, args := range [][]string{{"--pure=false"}, {"--pure", "false"}, {"--no-pure"}, {"--mini=false"}, {"--mini", "false"}, {"--no-mini"}, {"--log-level", "--pure"}, {"--worktree", "--mini"}, {"--", "--pure", "--hostname=x"}} {
		plan, native, err := InteractivePlan(args, nil)
		if err != nil || native || !slices.Equal(plan.Args, args) {
			t.Fatalf("changed compatible args %v: %+v/%v/%v", args, plan, native, err)
		}
	}
	for _, value := range []string{"true", "TRUE", "True", "tRuE", "1", "yes", "on", "y"} {
		if _, _, err := InteractivePlan([]string{"--no-pure"}, []string{"KILO_PURE=" + value}); err == nil {
			t.Fatalf("inherited enabling grammar %q", value)
		}
	}
	for _, value := range []string{"false", "no", "off", "0", "n", "FALSE", "YES", " true", "true ", ""} {
		plan, native, err := InteractivePlan(nil, []string{"KILO_PURE=" + value})
		if err != nil || native || opencodefamily.InteractiveEnvironmentValue(plan.Env, "KILO_PURE") != value {
			t.Fatalf("rewrote native false/malformed %q: %v", value, err)
		}
	}
}

func TestKiloNativePassthroughAndValueArity(t *testing.T) {
	for _, command := range passthroughCommands {
		args := []string{command, "-g", "native", "--pure"}
		plan, native, err := InteractivePlan(args, []string{"KILO_PURE=TRUE"})
		if err != nil || !native || !slices.Equal(plan.Args, args) || plan.Path != "kilo" {
			t.Fatalf("passthrough changed %v: %+v %v %v", args, plan, native, err)
		}
	}
	for _, args := range [][]string{{"--help", "--pure"}, {"--version"}, {"--pure", "false", "run"}, {"--mini", "false", "daemon"}, {"--auto", "false", "auth"}} {
		plan, native, err := InteractivePlan(args, nil)
		if err != nil || !native || !slices.Equal(plan.Args, args) {
			t.Fatalf("native command misclassified: %+v %v %v", plan, native, err)
		}
	}
	args := []string{"--worktree", "-g", "--session", "ses_exact", "--cloud-fork", "-g", "one,two", "--group=two,three", "-n", "literal", "--", "-g", "native"}
	plan, native, err := InteractivePlan(args, nil)
	if err != nil || native {
		t.Fatal(err)
	}
	if !slices.Equal(plan.Args, []string{"--worktree", "-g", "--session", "ses_exact", "--cloud-fork", "--", "-g", "native"}) {
		t.Fatal(plan.Args)
	}
	if opencodefamily.InteractiveEnvironmentValue(plan.Env, host.GroupsEnv) != `["one","two","three"]` || opencodefamily.InteractiveEnvironmentValue(plan.Env, host.NameEnv) != "literal" {
		t.Fatal(plan.Env)
	}
	if opencodefamily.InteractiveEnvironmentValue(plan.Env, host.SessionIDEnv) != "" {
		t.Fatal("invented native identity")
	}
	for _, args := range [][]string{{"-n", strings.Repeat("x", 129)}, {"-g", "a,,b"}} {
		if _, _, err := InteractivePlan(args, nil); err == nil {
			t.Fatal("invalid identity accepted", args)
		}
	}
}

func TestKiloResumeAliasAndNativeYoloBoundaries(t *testing.T) {
	for _, args := range [][]string{{"--yolo", "--resume", "ses_exact"}, {"--resume=ses_exact", "--yolo"}} {
		plan, native, err := InteractivePlan(args, nil)
		if err != nil || native {
			t.Fatal(args, err)
		}
		want := []string{"--yolo", "-s", "ses_exact"}
		if args[0] != "--yolo" {
			want = []string{"-s", "ses_exact", "--yolo"}
		}
		if !slices.Equal(plan.Args, want) {
			t.Fatalf("wrong alias/yolo argv: %q", plan.Args)
		}
	}
	for _, flag := range []string{"-n", "--peer-name", "-g", "--group", "--worktree", "--model", "--agent", "--prompt"} {
		args := []string{flag, "--resume", "--yolo"}
		plan, native, err := InteractivePlan(args, nil)
		if err != nil || native {
			t.Fatalf("value %s: %v", flag, err)
		}
		want := args
		if slices.Contains([]string{"-n", "--peer-name", "-g", "--group"}, flag) {
			want = []string{"--yolo"}
		}
		if !slices.Equal(plan.Args, want) {
			t.Fatalf("rewrote a value: %q", plan.Args)
		}
	}
	for _, args := range [][]string{{"--resume"}, {"--resume="}, {"--resume", "--"}, {"--resume", " "}} {
		if _, _, err := InteractivePlan(args, nil); err == nil {
			t.Fatal("missing ID accepted", args)
		}
	}
	for _, args := range [][]string{{"run", "--resume"}, {"--help", "--resume"}, {"run", "--resume=ses_exact", "--yolo"}, {"--", "--resume", "ses_exact", "--yolo"}} {
		plan, native, err := InteractivePlan(args, nil)
		if err != nil || !slices.Equal(plan.Args, args) {
			t.Fatalf("native boundary changed %q: %+v %v", args, plan, err)
		}
		if args[0] != "--" && !native {
			t.Fatal("lost native passthrough")
		}
	}
}

// SPDX-License-Identifier: MIT

package opencodefamily

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	sessionkit "github.com/antst/sessionbus/bus/sdk/go"
	"github.com/sessionbus/peer-common/host"
)

type modelRef struct {
	ID         string `json:"id"`
	ProviderID string `json:"providerID"`
}

var serverRules = []host.ArgumentRule{
	{Name: "--agent", TakesValue: true},
	{Name: "--print-logs"},
	{Name: "--log-level", TakesValue: true},
	{Name: "--mdns"},
	{Name: "--mdns-domain", TakesValue: true},
	{Name: "--cors", TakesValue: true},
	{Name: "--hostname", TakesValue: true, ConflictField: "topology"},
	{Name: "--port", TakesValue: true, ConflictField: "topology"},
	{Name: "-m", TakesValue: true, ConflictField: "model"},
	{Name: "--model", TakesValue: true, ConflictField: "model"},
	{Name: "-c", ConflictField: "session_id"},
	{Name: "--continue", ConflictField: "session_id"},
	{Name: "-s", TakesValue: true, ConflictField: "session_id"},
	{Name: "--session", TakesValue: true, ConflictField: "session_id"},
	{Name: "--fork", ConflictField: "session_id"},
	{Name: "--prompt", TakesValue: true, ConflictField: "arguments"},
	{Name: "--auto", ConflictField: "permission_mode"},
	{Name: "--mini", ConflictField: "arguments"},
	{Name: "--no-replay", ConflictField: "arguments"},
	{Name: "--replay-limit", TakesValue: true, ConflictField: "arguments"},
}

func launchArguments(open sessionkit.OpenOptions) ([]string, *modelRef, string, error) {
	return launchArgumentsFor(openCodeNative, open)
}
func launchArgumentsFor(kind nativeKind, open sessionkit.OpenOptions) ([]string, *modelRef, string, error) {
	if open.PermissionMode != "" && open.PermissionMode != "default" && open.PermissionMode != "bypassPermissions" {
		return nil, nil, "", fmt.Errorf("unsupported value permission_mode=%s", open.PermissionMode)
	}
	if open.ReasoningEffort != "" {
		return nil, nil, "", kind.err("does not support reasoning_effort")
	}
	validated, err := host.BuildArguments(open.Arguments, serverRules)
	if err != nil {
		return nil, nil, "", err
	}
	arguments, agent := make([]string, 0, len(validated)), ""
	for index := 0; index < len(validated); index++ {
		argument := validated[index]
		name, value, attached := strings.Cut(argument, "=")
		if name == "--agent" {
			if agent != "" {
				return nil, nil, "", errors.New("--agent accepts one value")
			}
			if !attached {
				index++
				value = validated[index]
			}
			agent = value
			if strings.TrimSpace(agent) == "" || strings.ContainsAny(agent, "\x00\r\n") {
				return nil, nil, "", errors.New("--agent requires a value")
			}
			continue
		}
		arguments = append(arguments, argument)
		if rule := slices.IndexFunc(serverRules, func(rule host.ArgumentRule) bool { return rule.Name == name }); rule >= 0 && serverRules[rule].TakesValue && !attached {
			index++
			arguments = append(arguments, validated[index])
		}
	}
	var model *modelRef
	if open.Model != "" {
		provider, name, found := strings.Cut(open.Model, "/")
		if !found || !nativeValue(provider) || !nativeValue(name) {
			return nil, nil, "", errors.New("model requires one provider/model value")
		}
		model = &modelRef{ID: name, ProviderID: provider}
	}
	return arguments, model, agent, nil
}

func nativeValue(value string) bool {
	return value != "" && strings.TrimSpace(value) == value && len(value) <= 256 && !strings.ContainsAny(value, "\x00\r\n")
}

// SPDX-License-Identifier: MIT

package opencode

import "github.com/sessionbus/opencode-kilo/wrappers/opencodefamily"

func validateManagedTopology(arguments, environment []string) error {
	return opencodefamily.ValidateOpenCodeTopology(arguments, environment)
}
func interactiveEnv(environment []string, key string) string {
	return opencodefamily.InteractiveEnvironmentValue(environment, key)
}
func normalizeManagedIdentity(environment []string) ([]string, error) {
	return opencodefamily.NormalizeInteractiveIdentity(environment)
}

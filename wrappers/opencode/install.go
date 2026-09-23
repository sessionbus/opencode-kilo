// SPDX-License-Identifier: MIT

package opencode

import "github.com/sessionbus/opencode-kilo/wrappers/opencodefamily"

// InstallOptions describes the native global configuration reconciliation.
type InstallOptions = opencodefamily.InstallOptions

func ConfigurePlugin(options InstallOptions) (bool, error) {
	return opencodefamily.ConfigureOpenCodePlugin(options)
}

func InstallPlugin(arguments []string) error {
	return opencodefamily.InstallOpenCodePlugin(arguments)
}

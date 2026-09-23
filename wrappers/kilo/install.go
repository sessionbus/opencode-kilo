// SPDX-License-Identifier: MIT
package kilo

import "github.com/sessionbus/opencode-kilo/wrappers/opencodefamily"

type InstallOptions = opencodefamily.InstallOptions

func ConfigurePlugin(options InstallOptions) (bool, error) {
	return opencodefamily.ConfigureKiloPlugin(options)
}

func InstallPlugin(arguments []string) error {
	return opencodefamily.InstallKiloPlugin(arguments)
}

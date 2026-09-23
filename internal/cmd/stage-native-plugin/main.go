// SPDX-License-Identifier: MIT

// stage-native-plugin is a development/build tool, not an installed command.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/sessionbus/opencode-kilo/internal/pluginstage"
)

func main() {
	repo := flag.String("repo", ".", "source repository")
	product := flag.String("product", "", "fixed product name")
	output := flag.String("output", "", "empty staging directory")
	tests := flag.Bool("tests", false, "include development tests")
	flag.Parse()
	if flag.NArg() != 0 || *output == "" || *product == "" {
		flag.Usage()
		os.Exit(2)
	}
	if err := pluginstage.Stage(*repo, *product, *output, *tests); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// SPDX-License-Identifier: MIT

// Command gen-opencode-tool writes the native JSON declaration from the shared
// Go MCP declaration. No native runtime SDK is needed to consume this JSON.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/sessionbus/peer-common/mcp"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: gen-opencode-tool OUTPUT_JSON")
		os.Exit(1)
	}
	data, err := json.MarshalIndent(mcp.Tool(), "", "  ")
	if err == nil {
		err = os.WriteFile(os.Args[1], append(data, '\n'), 0o644)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

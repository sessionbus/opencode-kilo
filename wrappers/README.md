# OpenCode-family wrappers

`opencode` and `kilo` retain separate launch, permission and install policies. `opencodefamily` contains their shared native plugin delivery and lifecycle implementation. The plugin registers the `sessionbus` tool in the product's existing Bun runtime. Build-time Node/npm assembles the published package; the Go maintenance executable installs it.

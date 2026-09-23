# OpenCode/Kilo functionality checklist

| Scope | Retained source and test contract | Installed status |
|---|---|---|
| OpenCode and Kilo Go commands | Original command tests and `--version` without native startup | Both `a1177770` permanent binaries installed; OpenCode `3168c64d`, Kilo `959ccecf` |
| Native plugin | Exact `sessionbus` tool, pinned kit, 62 OpenCode passes plus 11 Kilo-only skips, 73 Kilo passes | Installed plugin and registration bytes match each reviewed archive; fresh cells join the native `sessionbus` reply to the direct notification |
| Kilo lane permissions | `default` wildcard ask; `bypassPermissions` wildcard allow; other modes unsupported | KLW923A used an explicitly selected custom active agent with an exact Bash allowance; KLW923B selected built-in `code` without a config edit. These cells do not retest the full permission-mode matrix |
| TUI delivery | Native prompt submission starts work; no append-without-run claim | OpenCode interactive idle/active passed with an argv initial prompt and zero PTY writes; Kilo interactive surfaces remain untested and held |
| Archive and installer | Both product archives, checksum-gated bootstrap and Go maintenance install | Real-home install and idempotent reinstall passed independently for OpenCode and Kilo; the other product remained unchanged during each installation |
| OpenCode native 1.18.29 mapping and failed-turn frame | Marked UNVERIFIED in product facts | UNVERIFIED |

Fresh installed acceptance is per product and per surface:

| Product | Managed idle | Managed active | Interactive idle | Interactive active |
|---|---|---|---|---|
| OpenCode | OCW923B: original driver pass | OCW923C: original driver pass | OCW923E: original driver pass | OCW923F: original driver pass |
| Kilo | KLW923B: original driver pass, explicit built-in `code` agent | KLW923A: original driver pass, explicit custom agent | Untested/held: no reviewed Kilo harness | Untested/held: no reviewed Kilo harness |

OpenCode OCW923A and OCW923D are retained launcher first failures, not clean
passes. Their fresh successor cells above passed without replay. The retained
reply notifications are operator-attested raw observations joined to native
send results, not cryptographic receipts. OpenCode 1.18.32 and Kilo 7.6.2 are
observation provenance only. See [the extraction record](EXTRACTION-NOTES.md)
for packet locations and the source boundary. No tag, release or version change
is claimed; binary-release and package-preview publication remain held.

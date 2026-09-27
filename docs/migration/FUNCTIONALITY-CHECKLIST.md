# OpenCode/Kilo functionality checklist

| Scope | Retained source and test contract | Installed status |
|---|---|---|
| OpenCode and Kilo Go commands | Original command tests and `--version` without native startup | Both `a1177770` permanent binaries installed; OpenCode `3168c64d`, Kilo `959ccecf` |
| Native plugin | Exact `sessionbus` tool, pinned kit, 62 OpenCode passes plus 11 Kilo-only skips, 73 Kilo passes | Installed plugin and registration bytes match each reviewed archive; fresh cells join the native `sessionbus` reply to the direct notification |
| Kilo lane permissions | `default` wildcard ask; `bypassPermissions` wildcard allow; other modes unsupported | KLW923A used an explicitly selected custom active agent with an exact Bash allowance; KLW923B selected built-in `code` without a config edit. These cells do not retest the full permission-mode matrix |
| TUI delivery | Native prompt submission starts work; no append-without-run claim | OpenCode interactive idle/active passed (qualified; see extraction notes) with an argv initial prompt and zero PTY writes. Kilo interactive idle KIW924E and active KIW924D are accepted with the custom agent and model described below. The reviewed external harness watcher `9b0277fd` waits through pending/running tool parts and checks the completed reply and final |
| Archive and installer | Both product archives, checksum-gated bootstrap and Go maintenance install | Real-home install and idempotent reinstall passed independently for OpenCode and Kilo; the other product remained unchanged during each installation |
| OpenCode native 1.18.29 mapping and failed-turn frame | Marked UNVERIFIED in product facts | UNVERIFIED |

Fresh installed acceptance is per product and per surface:

| Product | Managed idle | Managed active | Interactive idle | Interactive active |
|---|---|---|---|---|
| OpenCode | OCW923B: original driver pass; qualified real-home (injected plugin inputs S1, S2) | OCW923C: original driver pass; qualified real-home (injected plugin inputs S1, S2) | OCW923E: original driver pass; qualified real-home (injected plugin input S1 only) | OCW923F: original driver pass; qualified real-home (injected plugin inputs S1, S2) |
| Kilo | KLW923B: original driver pass, explicit built-in `code` agent | KLW923A: original driver pass, explicit custom agent | KIW924E: independently reviewed clean original PASS, custom agent `sessionbus-wake-acceptance-20260922`, model `deepseek/deepseek-v4-pro` | KIW924D: independently reviewed clean original PASS, `queued_for_next_turn`, custom agent `sessionbus-wake-acceptance-20260922`, model `deepseek/deepseek-v4-pro`, exact Bash sleep auto-approved by its agent-config rule |

S1 and S2 are synthetic user rows injected by a host OpenCode skills-loader
plugin (not retained; source inferred), so OpenCode sole-new-model-input is
not established; see the retrospective audit note in
[the extraction record](EXTRACTION-NOTES.md).

OpenCode OCW923A and OCW923D are retained launcher first failures, not passes.
Their fresh successor cells above passed without replay (OpenCode qualified;
see above). The retained
reply notifications are operator-attested raw observations joined to native
send results, not cryptographic receipts. OpenCode 1.18.32 and Kilo 7.6.2 are
observation provenance only. See [the extraction record](EXTRACTION-NOTES.md)
for packet locations and the source boundary. No tag, release or version change
is claimed; binary-release and package-preview publication remain held.

KIW924A and KIW924C remain original FAILs, independently classified as harness
defects (A: absent-variant readiness check before inbound; C: pending-part
watcher after inbound), not product failures. The reviewed external acceptance
harness accepts an absent `variant` only for `kilo-peer-idle-*` and
`kilo-peer-active-*` titles; its lane checks still require `"default"`. Live
pending-state tolerance is inferred from native timestamps; the watcher's
pending/running handling is tested offline. KIW924E's pre-setup 7.8.1 update
notice did not install an update or require a PTY response. KIW924D's exact
`/usr/bin/sleep 45` was auto-approved with `{source: agent}` by its custom
agent's config, which sets Bash `*` to ask and allows that command only. Its
reply was operator-attested, with arrival observed about 6.9 seconds after the
native send ended (arrival operator-observed at 1-second resolution). Neither
interactive cell establishes Kilo's default agent
or default permission policy.

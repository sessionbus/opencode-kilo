# Sessionbus for Kilo

`kilo-peer` supplies managed interactive and lane entry points from one permanent
installation. Native server/TUI hooks run inside Kilo's existing Bun runtime.
The wrapper adds no Node runtime or separate interactive broker. This build is
tested on Linux with Kilo 7.8.1; earlier installed 7.6.2 results and their limits
are recorded in [ACCEPTANCE.md](../docs/designs/kilo-0.5.0/ACCEPTANCE.md). Known
behaviour deferred for later work is listed in [KNOWN-ISSUES.md](../docs/KNOWN-ISSUES.md).

## Build and install

Build tools are Go and npm. Install native Kilo first, then build this checkout:

```sh
scripts/package-product kilo ./dist
mkdir -p ./dist/kilo-install
tar -xzf ./dist/kilo-peer-linux-amd64.tar.gz -C ./dist/kilo-install
sh ./dist/kilo-install/install
```

Select the archive for your OS and architecture. The archive installs
`~/.local/bin/kilo-peer` and `~/.local/libexec/sessionbus/kilo`; its Go maintenance
entry reconciles native global server/TUI plugin registrations. Target installation
uses neither Node nor a native CLI subprocess. Installing only the Go command or
npm plugin does not provide the complete installation.

The installer parses all seven merged native config documents before writing,
preserves unrelated JSONC entries, and rejects aliased files. It removes the
historical `plugins/agent-sessions.js` only when its exact retained bytes match;
a different file fails clearly. Related helpers and dependencies remain untouched.
The shared transaction rolls back owned config/legacy removal on failure.

Managed execution accepts a direct native binary, an explicit `KILO_BIN_PATH`,
or the official npm installation's already selected regular `bin/.kilo` cache.
It preserves native tree-sitter resource selection and explicit resource settings.
An unsupported layout fails rather than spawning a Node shim or selecting a
platform package itself. This is a layout check, not runtime/version attestation.

## Interactive use

```sh
kilo-peer -g engineering,review -n 'working session'
kilo-peer --resume ses_exact_native_id
kilo-peer --yolo --resume ses_exact_native_id
```

A launch that selects no session (no `-s`/`--session`, `-c`/`--continue` or
`--prompt`) creates its native session at once, titled with `-n` when given, so
peers can reach it before anything is typed; that session stays in Kilo's
session list even if nothing is typed, as with opencode-peer.
`--resume ID` and `--resume=ID` map to native `-s ID`. Native `--yolo` passes
through unchanged and therefore changes permissions only when explicitly supplied.
Native value arguments and the literal `--` boundary retain their meaning.
Native subcommands/help pass through with their original arguments.

Managed TUI uses a direct native child with authenticated loopback HTTP on a
native-selected port, `KILO_NO_DAEMON=1`, and the actual launcher parent PID.
Caller topology overrides, enabled pure/mini modes, and Sessionbus local-key
transport are unsupported. Existing native auth is preserved; otherwise the
launcher generates a per-launch password. Native shell hooks clear the two
managed topology values for ordinary descendants; native auth stripping remains
Kilo's own policy. No caller config layer is replaced.

Ordinary Kilo plugin loading supplies no Sessionbus tool, endpoint or Peer. The
generic skill is registered for native discovery by local package installation.
Managed TUI selection establishes native
session Peers; an actual tool call can establish its own native session first,
including a native subagent child. Tool attribution always uses the actual native
session/message context. Navigation does not evict prior owners. Native deletion
or TUI disposal withdraws them. The initial name belongs only to the first route
selection, with native title confirmation; later titles remain native-owned.

An interactive inbound message to a busy session is appended to the user message
of the running task before its next model step (receipt `queued_for_next_turn`).
Inbound messages wait while native questions or permissions are pending.
Initial native blocker snapshots and live events are checked for the
exact session. The wrapper never answers or rejects an interactive blocker. An
idle handoff uses native `prompt_async` without inventing a message ID. A new
blocker can cross the final check and native submission; the API supplies no
atomic check-and-submit. `written` records successful native handoff/API acceptance, not proof
of model consumption. There is no replay or restart recovery.

On the installed 7.6.2 build, KIW924E is an independently reviewed clean
original PASS for an interactive idle wake, with an operator-attested reply.
Its peer session model omitted `variant`; the reviewed external acceptance-harness
checker accepts that shape only for `kilo-peer-idle-*` and
`kilo-peer-active-*` titles, while its lane checks still require `"default"`.
KIW924D is an independently reviewed clean original PASS for a
`queued_for_next_turn` active wake, with an operator-attested reply. Its
session model also omitted `variant`. Its custom agent's config sets Bash `*`
to ask and allows only the exact `/usr/bin/sleep 45`; the sleep was
auto-approved with `{source: agent}` by that test-specific agent-config rule,
not by a manual approval or default policy. These cells used
the custom config-defined agent `sessionbus-wake-acceptance-20260922` and model
`deepseek/deepseek-v4-pro`; they establish nothing about Kilo's default agent
or default permission policy. See [the product facts](../docs/products/kilo.md)
for the cell scope, earlier FAILs and the observed update notice.

## Lanes and lifetime

Public spawn selects product `kilo-peer`. One Worker Caller owns lane capability;
native child tools must prove the adopted session or native parent ancestry.
A Run uses the legacy synchronous native message request, reconciles native
assistant history, and has no wrapper silence deadline. A delivery during an
active Run joins that Run (receipt `injected`): before each model call the plugin
writes it as a text part of the user message that call answers, or the Run sends
it as one more message before it ends. A delivery to an idle lane, or after the
Run's final check, is refused before native submission; the daemon starts or
schedules an automatic managed Run carrying the original message.
`queued_for_next_turn` is bounded daemon scheduling, not native admission. Interactive and lane
permission behavior differs: unattended lane questions/permissions are rejected
under the selected lane contract. Omitted or `default` permission mode inherits
native policy. Explicit `permission_mode=bypassPermissions` supplies the native
session wildcard allow rule on creation or resume, preserving native hard guards
and leaving installation-wide configuration unchanged. This explicit caller choice
is separate from the Sessionbus custom tool, which executes directly in either mode.

Model selection follows native configuration or explicit `open.model` with a
native provider/model value. The wrapper does not inherit a displayed TUI model
or silently substitute one. Retained lane IDs cannot be reclassified as interactive
Peers merely by closing and resuming native history.

Normal launcher exit, TERM and HUP join the direct native child and remove launch
resources. Foreground INT retains native behavior. Abrupt launcher death can leave
a stale directory. Installed KILL observation records native and Peer absence
without attributing which native exit mechanism ran; stale-directory removal is
operator cleanup. Lane close aborts owned work and follows native TERM disposal;
forced close and exact exit diagnostics require separate evidence from the close
RPC result. Installed lifecycle results and their limits are recorded in
[ACCEPTANCE.md](../docs/designs/kilo-0.5.0/ACCEPTANCE.md).

Interactive bounds are 128 owned sessions (including retiring owners), 16 pending
identity establishments, 256 owned HTTP operations, 64 messages/1 MiB per-owner
FIFO and 16 MiB globally. A Peer shares a 256-task bound between delivery and tool
actions, so bursts can reject further work. The resident bridge has eight
connections and finite frame/write/work bounds. Native SDK response parsing and
native histories remain native-owned allocations. Common source is staged into
each self-contained product package; the only JS dependency is the immutable
Sessionbus kit at exact registry version `0.5.12`, with no plugin SDK, Effect or Solid package added.

Local package installation (`--plugin-dir` or a validated `file:` package directory)
registers the bundled generic Sessionbus skill through native `skills.paths`.
A fresh native instance discovers it; installation does not restart an existing
native process. Other native skill paths and permissions remain in effect.
Uninstall removes the identity-validated owned path alongside plugin entries.
Run `--sessionbus-install --remove` before deleting the package directory; its
manifest is needed to recognize owned local registrations.
Npm and tarball `--specifier` installs register the plugin only: without a local
extracted package directory they do not register a bundled skill path.

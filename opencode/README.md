# Sessionbus for OpenCode

Install the permanent Go launcher and native plugin on Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/sessionbus/opencode-kilo/main/scripts/install-opencode.sh | sh
opencode-peer -n project -g development,reviews
```

The archive contains the Go installer/launcher, a small JavaScript plugin that
runs inside OpenCode's existing Bun runtime, and the Sessionbus JS kit pinned
to exact registry version `0.5.7` in the package manifest and lockfile.
No separate Node, npm, Bun installation, Go broker, or native OpenCode patch is
required on the target. Source builds use Go and npm. The inspected released
native interface is OpenCode 1.18.29/1.18.30; installed acceptance is reported
separately from source compatibility.

The installer edits only owned entries in native global server/TUI JSON/JSONC
configuration, preserving comments and unrelated settings/plugins. Repeat
installation converges. Local package installation registers the bundled generic
Sessionbus skill for native discovery. Ordinary OpenCode exposes no Sessionbus
tool, peer, queue or action listener without a valid managed launch.

The same executable provides explicit maintenance:

```sh
opencode-peer --sessionbus-install --plugin-dir /absolute/permanent/plugin
opencode-peer --sessionbus-install --specifier @sessionbus/opencode@EXACT_VERSION
opencode-peer --sessionbus-install --remove
```

The native plugin package has no installer bin. Immutable package previews are
available through pkg.pr.new; this does not claim a stable npm release.

To build and install the same archive from a checkout (Go and npm are build
prerequisites):

```sh
scripts/package-product opencode ./dist
mkdir -p ./dist/opencode
tar -xzf "./dist/opencode-peer-$(go env GOOS)-$(go env GOARCH).tar.gz" -C ./dist/opencode
./dist/opencode/install
```

The installer places both the command and plugin under the normal permanent
user installation. Installing only the Go command or only the npm plugin does
not provide the complete integration.

Native selection flags, including new/resume/fork behavior, remain native.
`--resume <id>` and `--resume=<id>` before a literal `--` are rewritten in place
to the native two-token `-s <id>` form with the value forwarded verbatim; a value
of a wrapper flag (`-n`, `-g`) is never rewritten, no session lookup or ID
invention is performed, and native `-s`/`--session` stay authoritative.
Wrapper `-n` applies once to the first selected native session and publishes the
name only after native confirmation. Repeated comma-separated `-g` groups are
combined before `--`; native arguments after `--` are retained. Home has no
fabricated session. Native title changes update the same peer connection, and
an unnamed native session has no invented bus name.

A native session ID retained as a Sessionbus lane cannot register as an
interactive Peer, even after the lane is closed. Native resume can open that
history, but Peer admission returns `invalid_hello`; initial managed naming
then cannot complete. Closing a lane does not reclassify its native history.
Native-only interactive sessions can be resumed in fresh `opencode-peer`
launches. The wrapper does not invent another ID or automatically forget the
lane to bypass this boundary.

Each selected session remains addressable until native deletion or TUI disposal.
The public tool takes exactly `action` and `arguments`. Native tool context
binds every call to its actual session, including delayed old-session calls
and child/subagent calls. An interactive child becomes an addressable peer;
inbound input can run it outside the parent task. A lane child instead uses the
verified ancestor lane's single Worker capability.

Lane model selection follows native configuration. A caller can set an explicit
`open.model` such as `"google/gemini-3.1-pro-preview"` in a spawn request. A lane
does not implicitly inherit the displayed TUI model, and the wrapper never
silently substitutes a different provider/model. Native availability, credentials
and policy still govern the request.

The shared actions provide list/send/spawn/describe/run/start/wait/status/
interrupt/close/forget/ack. Status/wait do not consume results; acknowledge the
returned run explicitly. `list.self_info`, when supplied by the daemon, identifies
the caller even if filters exclude its row. Older daemons may omit it; names
and row ordering are not identity fallbacks.

Interactive delivery keeps bounded unsent input while native status is busy and
drains on native idle. A confirmed native handoff is `written`, not proof of
model consumption in that turn. Attempted input is never replayed after an
uncertain response, cancellation or terminal race. Native storage remains
native; no wrapper history, result journal or restart recovery is added.

The managed launcher selects authenticated native loopback HTTP so owned
requests can be cancelled and joined. Caller hostname/port/mDNS/CORS switches
and enabled pure mode conflict and fail clearly; native network options have
no short aliases in the inspected releases. Existing nonempty
`OPENCODE_SERVER_*` credentials are preserved, otherwise the launcher generates
a private password. Native auth environment can reach native shell-tool children.
Sessionbus launch variables are snapshotted and scrubbed in both native contexts.
Local-key Sessionbus transport is unsupported and fails before managed launch.
HTTP cancellation does not imply model cancellation. Remote attach requires a
separately equipped server and is not claimed by this local topology.

SIGTERM and SIGHUP join the direct native child and remove launch resources;
SIGINT remains a native TUI action. Abrupt launcher SIGKILL can leave the native
TUI, its peers and the unique directory alive. No extra supervisor is installed.
A failed TUI ownership claim is never transferred or recovered in that launch.

Owners are bounded to 128 including retirement, with 16 pending identity
establishments and 256 owned HTTP operations. Each owner retains at most 64
unsent messages/1 MiB, with a 16 MiB aggregate FIFO. The kit adapter shares a
256-work limit between tools and delivery, so a burst can reject new work.
The resident bridge allows eight connections, 2 MiB ingress, 8 MiB responses,
256 work and 32 MiB retained payload. Native SDK response parsing allocations
are outside these wrapper bounds. Kit ready reassignment is observed at its
pinned reconnect scheduler boundary; a failed attempt is never hello admission.

The rewrite's verified acceptance scopes and retained limitations are recorded in
[the acceptance index](../docs/designs/opencode-0.5.0/ACCEPTANCE.md). Historical
product probes remain separately identified in the product facts.

Local package installation (`--plugin-dir` or a validated `file:` package directory)
registers the bundled generic Sessionbus skill through native `skills.paths`.
A fresh native instance discovers it; installation does not restart an existing
native process. Other native skill paths and permissions remain in effect.
Uninstall removes the identity-validated owned path alongside plugin entries.
Run `--sessionbus-install --remove` before deleting the package directory; its
manifest is needed to recognize owned local registrations.
Npm and tarball `--specifier` installs register the plugin only: without a local
extracted package directory they do not register a bundled skill path.

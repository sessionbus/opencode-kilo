# Sessionbus for OpenCode

Install the permanent Go launcher and native plugin on Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/sessionbus/opencode-kilo/main/scripts/install-opencode.sh | sh
opencode-peer -n project -g development,reviews
```

The archive contains the Go installer/launcher, a small JavaScript plugin that
runs inside OpenCode's existing Bun runtime, and the Sessionbus JS kit pinned
to exact registry version `0.5.10` in the package manifest and lockfile.
No separate Node, npm, Bun installation, Go broker, or native OpenCode patch is
required on the target. Source builds use Go and npm. The target native is
OpenCode 2.0.21 (the v2 line with its background service). Interactive
behaviour has live acceptance evidence on that build for the recorded cells only;
lanes on OpenCode 2.0.21 are not yet live-proven. Installed acceptance is
reported separately from source compatibility.

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

A managed session stays on the bus while OpenCode keeps it loaded: closing the
TUI does not remove it, native session deletion does, and so does OpenCode
unloading its idle directory (about 60 minutes without activity). A session
whose TUI is still open is activated again when OpenCode reloads it. The public
tool takes exactly `action` and `arguments`. Native sub-agent (task) sessions
are never peers of their own: where OpenCode lets one use the tool, it speaks
as the managed session or lane it descends from.

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

A message to a managed session is one native steer prompt, and the receipt is
`injected` once OpenCode admits it. An idle session starts a new turn with it;
a busy session receives it at the next model step of the turn it is running,
not after that turn ends. The receipt is not proof of model consumption.
Attempted input is never replayed after an uncertain response. Native storage
remains native; no wrapper history, result journal or restart recovery is added.

`opencode-peer` replaces itself with the native TUI, which uses your background
OpenCode service as usual. The Sessionbus attachment lives in that service's
plugin, not in a separate process, so `opencode-peer` ignores `--standalone` and
`--server` (with its value) before `--`, and the TUI always starts on that service. Sessionbus launch variables are scrubbed
before native starts. Local-key Sessionbus transport is unsupported and fails
before managed launch. Signals and TUI exit end only the TUI; its session stays
on the bus until native deletes or unloads it, as above.

Lanes (sessions started through Sessionbus `spawn`) are clients of your
background OpenCode service, as native `opencode run` is: your logins, history
and default model apply. A lane never stops the service. A service restart ends
the lane's running Run (reported unavailable), after which OpenCode may continue
that turn by itself; killing a lane worker does not stop a turn already running.
A message to a busy lane reaches its current turn at the next model step. With
no human present, permission asks and questions in a lane are declined with a
message and the model continues, unless the lane was opened with
`permission_mode` `bypassPermissions`.

The kit adapter shares a 256-work limit between tools and delivery, so a burst
can reject new work. A lane's tool bridge allows eight connections, 2 MiB
ingress, 8 MiB responses, 256 work and 32 MiB retained payload.

The [acceptance index](../docs/designs/opencode-0.5.0/ACCEPTANCE.md) records the
OpenCode 1.18 rewrite's acceptance and is historical for OpenCode 2.0.21.
Historical product probes remain separately identified in the product facts.

Local package installation (`--plugin-dir` or a validated `file:` package directory)
registers the bundled generic Sessionbus skill through native `skills.paths`.
A fresh native instance discovers it; installation does not restart an existing
native process. Other native skill paths and permissions remain in effect.
Uninstall removes the identity-validated owned path alongside plugin entries.
Run `--sessionbus-install --remove` before deleting the package directory; its
manifest is needed to recognize owned local registrations.
Npm and tarball `--specifier` installs register the plugin only: without a local
extracted package directory they do not register a bundled skill path.

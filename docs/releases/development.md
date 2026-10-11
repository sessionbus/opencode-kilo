# OpenCode/Kilo development archives

This source tree can build OpenCode and Kilo peer archives for Linux and macOS on amd64 and arm64. The two products share a native plugin implementation while keeping separate commands, install and permission policies. The archive includes a Go maintenance installer, the native plugin package, `SOURCE.txt`, license and notices. Bootstrap downloads require a matching `SHA256SUMS` entry.

The native plugin build uses Node 24/npm to stage and pack the existing JavaScript payload with pinned `@sessionbus/kit` 0.5.12. The installed peer and plugin do not require a separate Node runtime; the native product supplies Bun. Stable releases are published from signed `vX.Y.Z` tags that match `RELEASE_VERSION`; see [v0.5.10](v0.5.10.md). Source tests are not a release claim.

## Changes since v0.5.10

- **A killed lane worker's tool socket is cleaned up.** A lane worker that is killed without closing (for example by SIGKILL) used to leave its tool socket file in the Sessionbus runtime directory until the next daemon start. Now, on Linux, the next OpenCode or Kilo lane worker to start on that host removes it. On macOS nothing changes: a refused connection there does not prove the worker is gone, so the file stays until the next daemon start. A worker killed during its own startup can still leave a `t-` socket file, which the next daemon start removes.
- **Kilo: a managed launch without the plugin registration is refused.** `kilo-peer` used to open an ordinary Kilo TUI, with no notice and no bus presence, when the Sessionbus plugin was no longer registered. It now reads the plugin lists in the global Kilo config directory before it starts Kilo. If the server list or the TUI list positively holds no Sessionbus entry, it starts nothing and prints the command that registers the plugin again.
  - Anything it cannot establish proceeds as before: an unreadable or unparsable file, an entry with `{env:...}` or `{file:...}`, a URL, `git:` or aliased entry, a local package that cannot be read, or a plugin file in that directory's `plugin` / `plugins` folder (server list only).
  - A registration kept only outside those global files (a project file, a `.kilo` directory, the `KILO_CONFIG*` or `KILO_TUI_CONFIG` variables, remote or managed config) is not recognised and the launch is refused.
  - Not detected: a plugin that is registered but switched off in Kilo, or that fails to load. OpenCode is unchanged.
- **Upgrade while no OpenCode or Kilo lane is running or starting.** A lane worker of an earlier build that is still starting when the first lane of this build starts could lose its tool socket.

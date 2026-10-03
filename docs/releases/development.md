# OpenCode/Kilo development archives

This source tree can build OpenCode and Kilo peer archives for Linux and macOS on amd64 and arm64. The two products share a native plugin implementation while keeping separate commands, install and permission policies. The archive includes a Go maintenance installer, the native plugin package, `SOURCE.txt`, license and notices. Bootstrap downloads require a matching `SHA256SUMS` entry.

The native plugin build uses Node 24/npm to stage and pack the existing JavaScript payload with pinned `@sessionbus/kit` 0.5.12. The installed peer and plugin do not require a separate Node runtime; the native product supplies Bun. Stable releases are published from signed `vX.Y.Z` tags that match `RELEASE_VERSION`; see [v0.5.10](v0.5.10.md). Source tests are not a release claim.

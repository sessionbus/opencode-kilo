# OpenCode and Kilo Sessionbus peers

Connect OpenCode and Kilo sessions through [Sessionbus](https://github.com/antst/sessionbus). The canonical source is [sessionbus/opencode-kilo](https://github.com/sessionbus/opencode-kilo). This repository contains the two Go peer commands, their shared native plugin, installers, tests and product facts. The bus daemon and public SDKs live in the Sessionbus repository; the shared Go host, MCP and version helpers come from the immutable `peer-common` module.

Read the [OpenCode guide](opencode/README.md) or [Kilo guide](kilo/README.md) for native activation, permission behavior and known limits. The product facts are in [OpenCode](docs/products/opencode.md) and [Kilo](docs/products/kilo.md). The [migration record](docs/migration/EXTRACTION-NOTES.md) identifies preserved behavior and remaining acceptance work.

## Install

Install the Sessionbus daemon and the native product first. Then use the matching installer with your real login home and PATH:

```sh
curl -fsSL https://raw.githubusercontent.com/sessionbus/opencode-kilo/main/scripts/install-opencode.sh | sh
curl -fsSL https://raw.githubusercontent.com/sessionbus/opencode-kilo/main/scripts/install-kilo.sh | sh
```

The bootstrap scripts verify the archive against `SHA256SUMS` before invoking the Go maintenance executable. A successful install places `opencode-peer` or `kilo-peer` and its native plugin under your normal `~/.local` installation. `scripts/package-product opencode ./dist` and `scripts/package-product kilo ./dist` build Linux or macOS archives from source. Native installation uses `--sessionbus-install --plugin-dir`; it does not invoke Node.

The **build and test environment does require Node 24 and npm** to assemble the existing native plugin and its pinned `@sessionbus/kit` 0.5.7 dependency. `scripts/package-product` runs the Go stager, `npm pack`, and `npm ci --omit=dev`. The installed plugin runs in the product's existing Bun runtime; no separate Node installation is added to the target. The source tests run with `go test ./...`, followed by `npm ci --ignore-scripts` and `npm test` in each of `opencode` and `kilo`.

Release and preview-publish workflows are retained for review but must remain disabled in the destination repository until publication is authorized. No installed acceptance claim follows from this source extraction alone.

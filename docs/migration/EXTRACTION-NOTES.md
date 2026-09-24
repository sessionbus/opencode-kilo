# OpenCode/Kilo extraction record

The source baseline is `710e5d33369cba4fb9468cd24fea0fe844a0219d`. The [preserved-file inventory](PRESERVED-FILES.json) records 154 protected files and their original SHA256, blob, mode and test registrations: 118 product-owned files, four shared product surfaces, and 32 shared-support files. OpenCode/Kilo source stays at the same paths. The shared host, MCP, version, socket and legacy-cleanup code is supplied by `github.com/sessionbus/peer-common v0.0.0-20260922143100-eb655f686e44` (commit `eb655f686e4456a4c1121054763318e3d27e89b0`). There is no filesystem replacement or Go workspace dependency.

The extraction retains both Go commands, both wrappers and their shared `opencodefamily` implementation, the product-owned plugin stager and generator, the native `.mjs` plugin and its tests, two npm manifests and exact `@sessionbus/kit` 0.5.7 lockfiles, the two installers, and the Go archive builder/maintenance installer. The native package versions `0.1.0-pre.1` are independent of `RELEASE_VERSION`. The former shared native-envelope fixture was copied byte-for-byte into `internal/pluginstage/testdata` solely for development tests; it is not packaged. The target installer invokes the Go maintenance executable, not Node. Build/test packaging requires Node 24/npm for the existing native plugin; installed hooks run in the native product's existing Bun runtime.

Kilo lane `default` permission still maps to a wildcard `ask` rule; `bypassPermissions` maps to wildcard `allow`. Other shared permission modes remain unsupported. The verified TUI delivery path submits a prompt and starts work. It does not establish append-without-run or running-turn injection. Both managed plugins register the exact native `sessionbus` tool, and lane readiness requires that ID. OpenCode 1.18.29 permission mapping and its failed-turn frame remain **UNVERIFIED**. Source extraction does not itself claim installed acceptance.

The bootstrap release URLs and both npm `repository` fields now identify `sessionbus/opencode-kilo`. The preview-package workflow retains both native package checks and two publish inputs, and the binary-release workflow retains the four target platforms. Both workflows must remain disabled on the destination repository until publication is authorized; in particular, `pkg-pr-new` is an outward publish action. The security workflow stages and scans each shipped native plugin separately, retaining its scanner pin, threshold and rules. Its hosted result must be checked before install/release.

The first product-scoped hosted scans scored 76 against the unchanged 80 threshold. The stager omitted the repository's MIT `LICENSE` from the native npm package even though the release archive already shipped that file at its root. The stager now includes the exact repository `LICENSE` in both native packages. The pinned offline scanner scores each staged package 84 (Security 13/16, Operational Security 3/6, Best Practices 6/6, Code Quality 10/10; 32/38 points). The scanner still reports missing `SECURITY.md` and Dependabot configuration as low-severity repository hygiene findings; neither is suppressed. This is a declared packaged-plugin payload addition, not a source behavior change.

The product facts and design records remain historical. `measure.py`, `SIZE.json` and `SIZE.md` record the original multi-product source tree and cannot be rerun as current extraction measurements. Their deleted cross-product paths resolve at the immutable baseline, not in this repository. The product facts' source citations likewise refer to original commits/paths. No product history, tested native behavior, or previous regression fix is intentionally discarded.

The original `feature/release-install` branch is archived and adds no unique OpenCode/Kilo fix above this baseline.

## Permanent installation and fresh behavior

Both final `a1177770` Linux archives were installed and reinstalled in the real
UMKA home. Under `/home/antst/sessionbus-evidence`, the independently reviewed
OpenCode install packet
`opencode-kilo-extraction-dev2-20260923/BINDING-OPENCODE-dev1.json` records the
replacement of `b2330276` with binary `3168c64d`; the Kilo packet
`opencode-kilo-installed-dev1-20260923/BINDING-KILO-dev1.json` records the
replacement of `3722de39` with binary `959ccecf`. Each pair of installer runs
exited successfully and produced equal safe installed observations. Installed
archive members, public aliases, registration and source bytes matched their
reviewed archives; the other product's installation and the Sessionbus service
remained unchanged. OpenCode 1.18.32 and Kilo 7.6.2 identify the observed
native versions, not a compatibility allowlist. Installation proves installed
bytes and layout; the cells below establish behavior separately.

OpenCode has four fresh **original-driver** passes on the installed build:
OCW923B managed idle, OCW923C managed active, OCW923E interactive idle and
OCW923F interactive active. Each cell retained one written or queued inbound,
an exact native Sessionbus reply, the requested native final and owned cleanup.
The interactive cells used an initial prompt in native argv, with zero PTY
writes; active cells retained their original live Bash witness at delivery.
OCW923A and OCW923D remain separate first-failure launcher packets and are not
counted as passes. Their subsequent harness corrections were tested by
fresh cells rather than rewriting those outcomes.

Retrospective audit note (external packet
`closed-inventory-retro-audit-opus-20260924` under
`/home/antst/sessionbus-evidence`, including its `INDEPENDENT-VERIFICATION.md`
and `ERRATA.md`; it extends the earlier `native-inventory-audit-dev1-20260923`
audit, which counted only ordinary (non-synthetic) user rows and substantive
finals): OCW923B, OCW923C, OCW923E and OCW923F are **qualified
real-home functional wake/reply passes**, not unqualified clean or
exclusive-input passes. The original driver and phase outcomes and the exact
native Sessionbus reply, requested final and owned-cleanup observations stand;
their evidence is immutable. Sole-new-model-input is **not established**: the
test host's real-home OpenCode environment injected synthetic user rows from a
host OpenCode skills-loader plugin (not retained; source inferred). The
installed Sessionbus plugin files contain no such injection. S1,
`<available-skills>` (4898 bytes, sha256
`d21595bd5a5005895bd2c6c9d41a0be58e8b06af37d73ab39415105bccaa67dd`), followed
setup in all four cells. S2, the skill-activation directive
`<skill-evaluation-required>` (612 bytes, sha256
`4f10ba4887b2e9e7588124ec9d8952505429c4a928286393811c3576a2f22e61`), followed
the Sessionbus inbound inside the wake turn in OCW923B, OCW923C and OCW923F,
not OCW923E; no additional tool call followed it. No product regression or
merge rollback is inferred; no plugin change or clean-room rerun is planned,
as the owner requires real-home testing. Future closed-inventory checks may
use a predeclared, per-run reviewed environment profile for known plugin
injections but must still disclose those inputs and keep the qualification.
Unknown rows fail; no after-the-fact allowlist turns a past run into an
exclusive-input proof.

Kilo has two fresh **original-driver** passes on the installed build: KLW923A
managed active and KLW923B managed idle. The retrospective audit does not
affect them: it found exactly their setup and inbound inputs, with no
injected rows. KLW923A explicitly selected the
config-defined `sessionbus-wake-acceptance-20260922` agent, whose retained
rules ask for other Bash commands and allow the exact `/usr/bin/sleep 45` used
by the test. Its agent-provenance note was added retrospectively and does not
change the original cell outcome. KLW923B explicitly selected the built-in
`code` agent with `--agent code`; no Kilo configuration or permission edit was
made for that idle test. Kilo interactive idle and active are **untested and
held** because a Kilo-specific acceptance harness has not been reviewed. They
are not recorded as product failures or as a native limitation.

The cell packets are under
`/home/antst/sessionbus-evidence/opencode-kilo-live-dev1-20260923` by the IDs
above. Direct replies are retained as operator-attested raw Sessionbus
notifications and joined to the native Sessionbus send results; they are not
cryptographic receipts. The reviewed runner and launcher manifests precede
the six fresh cells named above. These installed results make no tag, release,
or version change. Binary-release and package-preview publishing remain
disabled and held pending separate authorization.

# Kilo and shared native-family size — b71 draft

This is a measurement of source **b71a396b0fb184df886d2b8d83a834283a0df2b7**,
its two Linux/amd64 archives, and the retained installation snapshot from
2026-09-11 08:20:01 UTC. It is not final acceptance or a current host observation.
The historical [OpenCode measurement](../opencode-0.5.0/SIZE.json) remains unchanged.
[SIZE.json](SIZE.json) contains per-file hashes, exact input bindings, archive
members, dependency selections, native prerequisite observations and scope notes.

Canonical source is counted once. Both packages physically ship a copy of the
shared JS and kit; those copies are counted separately in disk totals. A source
file count is not a process count, and source bytes are not memory usage.

## Source

These rows are disjoint. Lines are physical lines including comments and blanks,
not executable LOC. Go rows include all tracked platform variants; the selected
Linux build is measured separately below.

| Source group | Files | Bytes | Lines |
| --- | ---: | ---: | ---: |
| Shared family Go runtime, including fixed product policies | 19 | 101,773 | 3,459 |
| Shared native JS runtime | 11 | 59,436 | 1,251 |
| Kilo Go facade, resolver and command runtime | 7 | 15,126 | 462 |
| OpenCode Go facade and command runtime | 7 | 7,568 | 258 |
| Shared MCP Go runtime | 4 | 27,448 | 803 |
| Shared family Go tests | 23 | 136,105 | 4,073 |
| Shared JS tests and fixtures | 12 | 65,604 | 1,347 |
| Kilo Go tests | 5 | 20,681 | 576 |
| OpenCode Go tests | 7 | 16,657 | 490 |
| Shared MCP Go tests | 5 | 39,258 | 1,074 |
| Shared plugin declaration and skill template | 2 | 11,737 | 172 |
| Shared build sources, scripts and tests | 8 | 15,063 | 453 |
| Kilo manifests and README | 3 | 8,141 | 179 |
| OpenCode manifests and README | 3 | 8,968 | 194 |

Other checkout files, including shared host machinery and unrelated products,
are a separate partition in JSON. The whole pinned checkout total overlaps these
partitions. The new measurement files are outside the pinned source total.
Build staging renders each product's generic skill from the one template;
rendered skill bytes belong to the payload, not another canonical source copy.

## Selected Go dependencies

`go list -deps -json` used Go 1.26.5, Linux/amd64, CGO disabled, the existing module
cache and `GOPROXY=off`. No package build or dependency download was performed.
The following sets are disjoint between common and product-only selections, but
overlap the source table above. They do not represent entire module caches.

| Selected source set | Files | Bytes | Lines |
| --- | ---: | ---: | ---: |
| Main-module files common to both commands | 28 | 147,129 | 4,933 |
| Main-module files selected only by OpenCode | 6 | 6,454 | 212 |
| Main-module files selected only by Kilo | 6 | 13,706 | 411 |
| External-module files common to both | 57 | 833,449 | 22,640 |
| External-module files unique to either command | 0 | 0 | 0 |

External modules are `github.com/antst/sessionbus/bus/sdk/go`
`v0.1.0-pre.2.0.20260910201437-8cc6a59fec72` and `golang.org/x/sys v0.30.0`.
`go version -m` reads each actual archived binary and records the same module
versions and target flags. Linked binary sizes already include Go's runtime and
standard library; adding selected dependency source bytes to them would be wrong.

## Actual payload and installation

| Cost | OpenCode | Kilo |
| --- | ---: | ---: |
| Compressed archive bytes | 2,298,411 | 2,309,404 |
| Archive regular members | 32 | 32 |
| Archive regular bytes | 5,453,708 | 5,476,978 |
| Linked Go binary bytes | 5,292,194 | 5,316,770 |
| Shared native JS copy bytes | 59,436 | 59,436 |
| Pinned JS kit bytes, 9 files each | 68,326 | 68,326 |
| Rendered generic skill bytes | 6,715 | 7,051 |
| Installed regular members | 30 | 30 |
| Installed regular bytes | 5,451,956 | 5,475,230 |

Compared with OpenCode's accepted [502 measurement](../opencode-0.5.0/IMPLEMENTATION.md),
its linked binary grew from 5,230,754 to 5,292,194 bytes (**+61,440**), and archive
regular bytes grew from 5,384,199 to 5,453,708 (**+69,509**). OpenCode also links
the shared family engine, including reachable branches of the fixed Kilo policy
switches; sharing source does not eliminate that linked cost. The intervening
changes also include shared skill registration and JS readiness changes, alongside
other source and payload updates. These are cumulative measured deltas, not a
per-change allocation of binary bytes; the JS readiness change contributes to
payload rather than the Go binary.

The two installations occupy **10,927,186 regular-file bytes** in this snapshot.
Subrows overlap their totals. Install scripts and ROLE archive metadata are not
permanent members. Public executable aliases resolve to each installed binary
and add no duplicate target bytes. This measures file lengths, not filesystem
block allocation or symlink storage. Archive and installed names, sizes and hashes
are checked exactly; permissions are retained separately in JSON.

The kit is the immutable `0b35c99` preview pinned in both package locks; the full
URL/integrity and every shipped file hash are recorded. It executes inside the
already required native Bun runtime. Maintenance uses the Go command; this change
adds no target Node installation, independent Bun runtime, or installer dependency.

## Existing native prerequisites and unmeasured costs

The retained inventory observes OpenCode's native executable at **184,825,984
bytes**, Kilo's native `.kilo` executable at **168,618,112 bytes**, and its separate
5,780-byte launcher. Package metadata identifies OpenCode 1.18.30 and Kilo 7.6.2.
These are existing prerequisites, not incremental wrapper payload. JSON retains
resolved paths and hashes once per physical target, including the small package
manifests. This is **not** a recursive measurement of either complete native package.

The Go launcher/Worker and existing native child, native Worker threads, loopback
HTTP listener and resident action bridge have runtime costs. This report does not
measure RSS, peak allocations, process/thread counts under load, configured native
tool descendants, daemon history storage, or the full native installation. Shared
source does not imply shared memory or shared physical installation across products.

## Reproduce from retained evidence

From the separate measurement worktree, run:

```sh
python3 docs/designs/kilo-0.5.0/measure.py \
  /home/antst/kilocode-architecture-20260911/implementation-dev1/readiness-b71/BUILD.json \
  /home/antst/kilocode-architecture-20260911/implementation-dev1/readiness-b71/dist \
  /home/antst/kilocode-architecture-20260911/installed-readiness-b71-dev1/capture/after.json
```

The script checks source blobs against BUILD, archive hashes and members against
BUILD, canonical JS against each archive, selected local Go source against the
pin, and permanent files against each archive. It reads binary build metadata
without executing the binaries. The local Go cache is required; missing modules
fail rather than downloading. It rewrites SIZE.json only. SIZE.md is the reviewed
draft interpretation, not a generated acceptance report.

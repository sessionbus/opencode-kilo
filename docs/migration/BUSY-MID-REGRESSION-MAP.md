# OpenCode/Kilo active input regression map

This candidate uses the installed legacy engines' experimental
`experimental.chat.messages.transform` hook and additive `part.update` API:
OpenCode 1.18.33 (`51ef4be1`) and Kilo 7.6.2 (`3d04228`). The resident native
plugin and its existing endpoint transport are retained. There is no new
process, runtime, dependency, socket or history copy. The reviewed peer-common
private-method seam is pinned to `a38c747e`.

Hook admission, persistence and assembly of model context are distinct from
observed model reaction. This map records deterministic checks; it does not
claim permanent-install BUSY-MID or IDLE-WAKE acceptance.

## Ownership and native representation

`chat.message` captures an admitted user tuple before native persistence. Bind
does not perform a GET. Interactive authorization uses the existing live owner
generation and an opaque owner-held binding; same-process native extensions are
trusted. A lane additionally requires the root, current phase's initially
admitted user and exact Worker Run. Unknown methods/operations have no effects.

At each model-step hook the exact native current user object and chronology are
frozen before awaiting the endpoint. The FIFO remains solely endpoint-owned.
A bounded prefix becomes one attributed text part on that user, preserving all
authored parts and each bus sender/message identity. It is not a separate native
user message. Ownership transfers immediately before JS invokes `part.update`,
or after Go successfully begins the owned PATCH. Uncertain attempts never return
to the FIFO. A confirmed part is appended once to the frozen model context.

Both installed engines reload parts in SQLite BINARY ID order. The hook freezes
the maximum ASCII part ID, and the existing owner/phase also retains the last
attempted ID for that exact parent, including response loss. The bounded local
generator advances beyond both floors before claiming input. Its 256-byte
metadata/output bound is an adapter contract, not a native PartID limit;
representability refusal leaves input never-attempted. Random suffixes provide
crypto-grade uniqueness, not an absolute concurrent-writer collision guarantee.

Never-attempted leftovers alone may use idle wake. A lane seals and joins the
old phase, then atomically closes empty admission or reserves a synchronous
successor within the same Worker Run. Interrupt targets that exact phase. The
final result includes the last owned operation, projected from the original
Run input. Native v2 steer exists, but has a different engine/history and no
compatible whole-execution wait; it is not used here.

## Required behavior to tests

Paths below are relative to `wrappers/opencodefamily`; JS suites run for both
product profiles. Go product subtests exercise both products unless named Kilo.

| Gate | Behavior | Deterministic test |
|---|---|---|
| R1 | Active FIFO becomes a durable additive part before Run completion; authored text and attributed envelope order remain intact | `native_input_test.go:TestNativeInputBusyStepPersistsFIFOWithoutEndingRun`; `plugin/delivery.test.mjs:busy FIFO hands one additive part to the next model step without idle`; `plugin/owners.test.mjs:owned hook inserts a durable additive part during busy work on the exact session` |
| R2 | Freeze parent across concurrent human input; native chronology across compaction, equal times and imported IDs | `plugin/native-input.test.mjs:current user follows native chronology through projection and equal-time IDs`; `hook freezes the current user before concurrent human input and keeps authored parts` |
| R2/R10 | Strict root, active phase, chronology, token and live owner generation before FIFO effects | `native_input_test.go:TestNativeInputExactPhaseAndRootGuardBeforeFIFO`; `plugin/owners.test.mjs:foreign, retired and stale-generation hook bindings cannot touch the owned FIFO`; `plugin/native-input.test.mjs:older binds cannot overwrite a newer anchor and older contexts cannot claim input`; `refused bind does not redirect a child or an unrelated context` |
| R2b/R10 | A Task chat preceding public-tool adoption creates no owner; a later native hook may bind only a never-bound exact live child, with parent untouched and no stale-token rebind | `plugin/owners.test.mjs:late public adoption lets a child hook claim only its exact active inbox` |
| R3 | Duplicate/prune hook and history reload cannot repeat handoff or append the same part twice | `plugin/native-input.test.mjs:duplicate and prune hooks append only confirmed once-owned parts; reload retains history`; R1 Go test's repeated-step assertions |
| R1/R3/R4 | SQLite BINARY part ordering keeps authored bytes first and batches FIFO, including stale snapshots after successful or uncertain attempts | `native_input_test.go:TestNativePartIDByteOrderingBounds`; `TestNativePartOrderingUncertainSnapshotAndParentReplacement`; `TestNativePartInvalidBoundDoesNotTouchFIFO`; `plugin/native-input.test.mjs:part ID generation preserves ASCII byte order at equal entropy and bounded edges`; `plugin/delivery.test.mjs:stale part snapshots keep successful and uncertain batches ordered after authored bytes`; `invalid or exhausted part bounds leave the unsent FIFO untouched` |
| R4 | Pre-attempt cancellation/refusal retains ownership; native/private response loss after attempt never replays | `native_input_test.go:TestNativeInputPreflightRefusalAndAttemptedLossNeverReplay`; `plugin/delivery.test.mjs:pre-attempt hook refusal and cancellation preserve owned input`; `plugin/native-input.test.mjs:private reply loss after native ownership is surfaced and never manufactures local context` |
| R4 | A native halt observed before step invocation does not permit a late PATCH | `plugin/owners.test.mjs:known halt before step invocation keeps never-attempted input owned` |
| R4b | A held pre-halt step cannot revive after idle then busy on the same binding | `plugin/owners.test.mjs:an idle then busy crossing never revives a held pre-halt step`; the step freezes the owner's idle-observation epoch through the final attempt check |
| R4/R10 | End/disposal cancels and joins in-flight step work | `native_input_test.go:TestNativeInputEndCancelsAndJoinsAttemptedStep`; `plugin/owners.test.mjs:End disposal cancels and joins an in-flight native step without restoring its batch`; `plugin/server.test.mjs:private unsupported operation has no consumer effects; End cancels a held hook` |
| R5/W6 | Existing early halt, completion plus following idle, prior-turn generation, later user, repeated busy and pending snapshot guards stay intact | All existing `plugin/owners.test.mjs` OpenCode busy/terminal tests, including `OpenCode fallback snapshot rechecks an assistant observed while pending` |
| R5 | Hook delivery preserves pending Kilo questions/permissions; returned successor blockers prevent POST and retain input until clear/cancel; observed events invalidate a clean snapshot before begin | R1 owners test with both blocker kinds pending; `native_input_test.go:TestKiloSuccessorObservedBlockerAndCancelDoNotPost` (held-query cancellation); `TestKiloSuccessorReturnedBlockerRetainsInputUntilEventOrCancel`; `TestKiloSuccessorObservedEventInvalidatesCleanSnapshotBeforeBegin`; existing Kilo snapshot/live/final-invocation tests remain |
| R6/W3/W4 | Deliver crossing native completion recovers FIFO in the same Run; admission closure rejects before effect and permits one idle Run | `native_input_test.go:TestNativeInputCompletionAndAdmissionClosureBothSidesWakeOnce` |
| R6/W7 | Fresh successor phase, old-token rejection, interrupt after begin, result includes last operation; no post-return work | `native_input_test.go:TestNativeInputFinalCompletionRecoversFIFOInSameRun`; `TestNativeSuccessorInterruptBeforeBeginNeverStartsWork` |
| R6/W3/W7 | No bind and bound-without-step both preserve healthy completion recovery and tools; no early result or fabricated interrupted terminal; no post-cancel wake | `native_input_test.go:TestNativeInputHealthyCompletionWithoutHookPreservesRecoveryAndTools`; `TestNativeInputNoHookSuccessorWaitsForItsOwnTerminal`; `TestNativeInputInterruptAfterCompletionBeforeRecoveryKeepsRealTerminal` |
| R7 | Reciprocal tool work returns before the next hook; Deliver never awaits model-step handoff | `plugin/server.test.mjs:resident hook uses a private method and reciprocal tool work returns before the next step`; R1 Go test collects both receipts before invoking step |
| R9 | Private method uses existing default dispatch, contexts, budgets, cancellation and joins; public catalog/actions remain unchanged | Reviewed peer-common PR #4 tests at merged `a38c747e`; `native_input_test.go:TestNativeInputResidentPrivateDispatchPreservesPublicCatalog`; unchanged endpoint/forwarder suites |
| R10 | Unknown methods/operations have no consumer effects; binding depends on owner-held state | Private dispatch test above; server unsupported-operation test; exact phase/root and owner-generation tests above |
| R11 | An exact-parent, non-summary assistant's native step-start without an observed hook records a diagnostic only; tools, FIFO and idle wake continue, and the next valid hook can drain inside the same task | `plugin/owners.test.mjs:unobserved hook diagnostic preserves tools and later idle wake`; `next valid hook drains retained input in the same task after an unobserved step`; `an empty-FIFO unobserved-step diagnostic does not infer permanent delivery failure`; `empty hook before the first busy event proves the model-step integration`; `summary, static, subtask and stale-parent evidence does not falsely retire integration` |
| W1 | Already-idle input starts native work without human follow-up | Existing `TestLegacyWorkerSeedWrittenAndRetainedCursor`, interactive `idle-time delivery hands off directly without a prior assistant snapshot`, and retained delivery idle tests |
| W2 | Next-step admission while original work is active | R1 tests; actual model reaction remains a permanent-install gate on all four surfaces |
| W3 | Hook versus idle claim is serialized, including idle while hook owns an empty queue and a later unsent arrival | `plugin/delivery.test.mjs:hook and idle serialize claims; disposal joins an attempted part update`; `idle event while a hook owns an empty FIFO wakes later input before that hook joins`; R6 completion/closure test |
| W4 | Multiple unattempted messages preserve FIFO and wake after normal completion | R6 completion/closure test; retained FIFO/demand delivery tests |
| W5 | Attempted or uncertain input never replays | R4 tests and all existing uncertain-handoff/receipt tests |
| W6 | Delayed idle, generation and snapshot regressions remain | Existing owner tests, `plugin/review-delivery-idle.test.mjs`, `plugin/review-delivery-receipt.test.mjs`; daemon wake tests are not changed by this repository |
| W7 | Cancel/interrupt/close join ownership without unauthorized later wake | R4/R6 tests; existing lane terminal precedence, shutdown, permission rejection and interactive cancellation tests |

## R8: preservation record

No existing test function is deleted or renamed. All original assertions remain.
`lane_test.go:TestLegacyWorkerTerminalWhileSeedReportHeldAndBusLoss` follows the
same owned operation through `run.phase.original` instead of `run.original`;
its held-report, terminal, bus-loss and join assertions are unchanged. Native
HTTP fixtures add PATCH persistence, blocker snapshots and deterministic phase
and final-projection gates without changing old scenario behavior. The explicit
package allowlist gains only the required `native-input.mjs` runtime file.

The old active-delivery refusal test still checks that a delivery without an
active supplied Run is refused before native write. New exact-Run admission
tests strengthen coverage for the supported busy path. Existing native terminal
precedence, result retention, permission refusal, uncertainty, capacity,
readiness and native tool metadata tests remain. No assertion is intentionally
weakened. All four live BUSY-MID and IDLE-WAKE surfaces remain required after
reviewed permanent installation; none is marked PASS here.

## Kilo successor limitation (source-only, not a policy PASS)

The blocker snapshot and final event check are pre-invocation checks, not an
atomic native lease. Kilo 7.6.2's same-root `/command` can open a blocking
resume-picker question after the final clean check but before ordinary POST;
that POST dismisses root questions. Native source: session handler 362–369;
prompt 2330–2332, 2360–2362, 2188–2199, 1499–1501; control 33–45;
question `makeDismissAll` 56–64. The released interactive idle fallback has
the same native check-to-invocation boundary. This candidate does not claim to
make it atomic or authorize dismissal. A preexisting or observed blocker gets
zero successor POST and keeps bounded never-attempted ownership until a native
event or cancellation. Additive hook delivery bypasses prompt intake and does
not dismiss blockers.

`native_input_test.go:TestKiloSuccessorDocumentsExternalQuestionAfterFinalCheck`
forces the external question crossing and models native dismissal. It records
the residual, not blocker preservation or policy acceptance. A live policy
failure is not waived by this fixture. No timer, polling, noReply, native fork
or extra recheck is added. This wording must carry into the eventual release
note when its version is selected.

## Acceptance boundary

The owner's clarification is: "I mean next model step" and "it missed on this
step, we will push on another step ... where is failure here?" One unobserved
callback is not proof of failure or lasting capability loss. Still-owned input
may reach a later valid model-step hook inside the same original native task;
this is delayed active delivery, without replay of any attempted handoff. The
positive witness diagnostic changes no lifecycle, receipt or queue semantics.
It adds no toast, disconnect or presentation flag.

Actual acceptance still requires native consumption/reaction before that
original operation ends. Same-Worker-Run successor work and final-idle delivery
do not count as BUSY-MID. Earliest-boundary index/misses and elapsed time are
latency evidence, separate from the active-delivery outcome. Live evaluation
uses the reviewed matrix correction; this file changes no historical verdicts.
The pre-fix permanent baseline must run with the same pinned driver/evaluator
before a candidate installation. All four live surfaces and O1/O2 controls
remain NOT-RUN here; deterministic tests do not replace them.

## Change-consequence analysis

The source plan and its R1b/R2b/R4b/R5 revisions were independently bounded by
Dev1 before implementation. This records their consequences for immutable-head
review; local green tests alone do not adopt or establish product conformance.

| Case | Intended effect and retained behavior | Consequence or remaining constraint |
|---|---|---|
| Connection, presence and tools | Existing kit Peer, resident endpoint, public catalog and all 13 actions remain | A model-step diagnostic does not disconnect, dispose, forbid later hooks or change receipts. Ordinary identity deletion, transport failure and explicit shutdown retain their existing lifetime policy. |
| Empty or populated active inbox | Empty hooks record the boundary without PATCH. Busy arrivals return bounded admission immediately; the next legitimate hook claims a FIFO prefix. | Admission is owned memory, not consumption. At most 64 messages / 1 MiB per owner/Run; existing interactive global accounting remains 16 MiB. Overflow rejects before ownership, with no unbounded background wait. |
| Native identity and human input | Freeze native current user, chronology and part floor before the first await; preserve original authored text. | Concurrent later human input cannot retarget an in-flight batch. Mixed sessions, unsupported metadata and foreign/stale binding refuse before FIFO effects. Public Task ancestry grants no lane inbox ownership. |
| Late Task adoption | A never-bound transform may ask the existing exact live-owner guard after a public child tool establishes it. | Hooks create no owners and never repair an accepted stale token by rebinding it. Parent and child queues remain independent. |
| Confirmed or uncertain handoff | Transfer ownership only at the conservative native invocation/begin boundary, then never restore attempted input. | Success returns one confirmed additive part; lost HTTP/private replies, crossing cancellation or later model failure cannot replay it. Later hooks may claim only still-unsent entries. |
| Persistence and ordering | Keep an additive part on the frozen current user and append its confirmed result once to the current context. | Reload order is SQLite BINARY part ID order. Advance the last-attempt floor even on response loss; stale snapshots cannot reorder FIFO batches. ASCII/output exhaustion within the adapter's bound refuses before claim, not proof native has no possible ID. |
| Halt or status-query crossing | A pending interactive hook retains its entry idle-observation epoch through final invocation, respecting event precedence over stale queries. | Observed idle cannot be erased by subsequent busy. Initial bind-idle before first busy remains allowed. This is observed cancellation evidence, not an atomic native-abort guarantee. |
| Hook versus idle wake | Serialize both paths through the existing delivery queue/work slot; retain idle demand while a hook owns an empty queue. | A later unsent arrival must still wake after that hook joins. Valid integration keeps all prior assistant-generation, completion/idle and snapshot protections. Attempted input never enters idle fallback. |
| Completion versus Deliver | Seal and join phase handoffs, then atomically close admission on empty or reserve the next phase before unlocking. | Arrivals before closure remain owned; arrivals after closure return NotRunning for daemon idle recovery. A synchronous successor is new native work inside the same Worker Run and never BUSY-MID evidence. Missing bind/step observations alone do not fail the owner or dispose accepted input; malformed/failed native results still cannot enter healthy recovery. |
| Interrupt, close and owner loss | Target exactly the current phase, cancel before begin or interrupt/join after begin; preserve native terminal precedence and result retention. | Explicit interruption/close ends never-attempted ownership truthfully and cannot schedule later wake. Actual transport/protocol failures keep existing unavailable/retirement handling. No result returns while owned successor work continues. |
| Kilo permission/question boundaries | Hook PATCH bypasses prompt intake and preserves blockers. Successor waits on observed blockers/events and checks the event epoch before begin. | No atomic native lease exists. An external same-root command can introduce a question after the final clean check; ordinary POST can dismiss it, as at the released idle fallback boundary. The forced residual fixture is not a preservation PASS. |
| Diagnostics and later continuity | One positively correlated model step without an observed hook records an event-local console diagnostic only; report exceptions are isolated. | This proves neither permanent capability loss nor message failure. A later valid hook in the same task may deliver owned input. No toast/presentation flag or diagnostic-triggered retirement is adopted. |
| Reconnect and replacement | Existing kit reconnect behavior, normal owner generations and lane phase guards remain. | Reconnect is not permission to resend native attempts. Old owner/Run tokens cannot claim a replacement inbox; normal new native chat binds use its own exact owner state. |

The required native plugin hook and TUI extension already run JavaScript in
OpenCode/Kilo's native runtime. They must mutate the native in-process model
context and call its provided SDK; an out-of-process Go callback cannot replace
that capability. This change adds no Node/Bun process, install-time runtime,
runtime npm operation or JavaScript dependency. Go continues to own lane RPC,
process lifetime and result accounting. The peer-common pin is the independently
reviewed additive seam, not a new generic adapter or public action.

The authorizing review plan, this analysis, deterministic adverse/continuity
tests and permanent-install evidence are separate gates. Any new functionality
loss or causal live failure requires source review; no latency assumption,
receipt or diagnostic silently weakens the active/idle messaging requirement.

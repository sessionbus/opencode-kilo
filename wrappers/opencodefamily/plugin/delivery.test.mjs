// SPDX-License-Identifier: MIT

import { nativeProduct } from "./profile.mjs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { NativeDelivery, renderDelivery } from "./delivery.mjs";

const message = (n, body = "hello") => ({ message_id: `message_${n}`, body, from: { product: "test", session_id: "sender", groups: [] } });
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
function setup(t, overrides = {}) {
  const life = new AbortController(), submissions = [];
  let bytes = 0;
  const delivery = new NativeDelivery({ sessionID: "ses_native", signal: life.signal,
    status: async () => "idle", info: async () => ({ directory: "/native", agent: "native-agent", model: { providerID: "native-provider", id: "native-model", variant: "native-variant" } }),
    reserve: (size) => { bytes += size; return true; }, release: (size) => { bytes -= size; },
    submit: async (parameters, _signal, attempted) => { attempted(); submissions.push(parameters); },
    ...overrides,
  });
  t.after(async () => { life.abort(); await delivery.dispose(); assert.equal(bytes, 0); });
  return { delivery, life, submissions, bytes: () => bytes };
}

test("busy stage uses native idle event then one explicit native-session submission", async (t) => {
  let status = "busy";
  const f = setup(t, { status: async () => status });
  assert.equal((await f.delivery.enqueue(f.life.signal, message(1))).disposition, "queued_for_next_turn");
  assert.equal(f.submissions.length, 0); assert.ok(f.bytes() > 0);
  status = "idle"; await f.delivery.idle(); await f.delivery.idle();
  assert.equal(f.submissions.length, 1); assert.equal(f.bytes(), 0);
  const p = f.submissions[0];
  assert.equal(p.sessionID, "ses_native"); assert.equal(Object.hasOwn(p, "path"), false);
  assert.deepEqual(p.model, { providerID: "native-provider", modelID: "native-model" });
  assert.equal(p.agent, "native-agent"); assert.equal(p.variant, "native-variant");
  assert.match(p.parts[0].text, /message_1/);
  if (nativeProduct.nativeMessageID) assert.equal(Object.hasOwn(p, "messageID"), false);
  else assert.equal(p.messageID, `msg_${createHash("sha256").update("message_1").digest("hex").slice(0, 32)}`);
});

test("attempted uncertain native handoff is never restored or retried", async (t) => {
  let attempts = 0;
  const f = setup(t, { submit: async (_p, _s, attempted) => { attempted(); attempts++; throw new Error("native response lost"); } });
  assert.deepEqual(await f.delivery.enqueue(f.life.signal, message(1)), { disposition: "rejected", reason: "native response lost" });
  await f.delivery.idle(); assert.equal(attempts, 1); assert.equal(f.bytes(), 0);
});

test("known pre-submit refusal preserves already receipted unsent input", async (t) => {
  let status = "busy", refuse = true, attempts = 0;
  const f = setup(t, { status: async () => status, submit: async (_p, _s, attempted) => {
    if (refuse) throw new Error("HTTP work bound"); attempted(); attempts++;
  } });
  assert.equal((await f.delivery.enqueue(f.life.signal, message(1))).disposition, "queued_for_next_turn");
  status = "idle"; await assert.rejects(f.delivery.idle(), /HTTP work bound/);
  assert.ok(f.bytes() > 0); assert.equal(attempts, 0);
  refuse = false; await f.delivery.idle(); assert.equal(attempts, 1); assert.equal(f.bytes(), 0);
});

test("per-owner FIFO count and byte limits reject without evicting prior input", async (t) => {
  const f = setup(t, { status: async () => "busy" });
  for (let index = 0; index < 64; index++) assert.equal((await f.delivery.enqueue(f.life.signal, message(index))).disposition, "queued_for_next_turn");
  assert.equal((await f.delivery.enqueue(f.life.signal, message(65))).disposition, "rejected");
  const second = setup(t, { status: async () => "busy" });
  assert.equal((await second.delivery.enqueue(second.life.signal, message(1, "x".repeat(1024 * 1024)))).disposition, "rejected");
  assert.equal(second.bytes(), 0);
});

test("owned cancellation joins an attempted native handoff without replay", async (t) => {
  const entered = deferred(), release = deferred(); let signal, attempts = 0;
  const f = setup(t, { submit: async (_p, cancel, attempted) => {
    signal = cancel; attempted(); attempts++; entered.resolve(); await release.promise; throw cancel.reason;
  } });
  const receipt = f.delivery.enqueue(f.life.signal, message(1));
  await entered.promise;
  f.life.abort(new Error("native deleted")); let closed = false;
  const disposing = f.delivery.dispose().then(() => { closed = true; });
  assert.equal(signal.aborted, true); assert.equal(closed, false);
  release.resolve(); await disposing; assert.equal((await receipt).disposition, "rejected");
  await f.delivery.idle(); assert.equal(attempts, 1);
});

// Unchanged shared expected bytes preserve the historical renderer contract.
test("native delivery matches the retained shared message envelope", async () => {
  const fixture = JSON.parse(await readFile(new URL("./native-message-envelope.json", import.meta.url), "utf8"));
  assert.equal(renderDelivery(fixture.message), fixture.rendered);
});

test("queued receipt survives later sender cancellation until native idle", async (t) => {
  let status = "busy";
  const f = setup(t, { status: async () => status });
  const sender = new AbortController();
  assert.equal((await f.delivery.enqueue(sender.signal, message(1))).disposition, "queued_for_next_turn");
  sender.abort(); status = "idle"; await f.delivery.idle();
  assert.equal(f.submissions.length, 1);
});

const parent = { sessionID: "ses_native", messageID: "msg_current", created: 100, after: "prt_authored" };
test("busy FIFO hands one additive part to the next model step without idle", async (t) => {
  const patches = [];
  const f = setup(t, { status: async () => "busy", patch: async (part, _signal, attempted) => {
    attempted(); patches.push(structuredClone(part)); return part;
  } });
  await f.delivery.enqueue(f.life.signal, message(1, "first"));
  await f.delivery.enqueue(f.life.signal, message(2, "second"));
  const parts = await f.delivery.step(f.life.signal, parent, () => true);
  assert.equal(f.submissions.length, 0); assert.equal(patches.length, 1);
  assert.equal(parts[0].messageID, parent.messageID); assert.equal(f.bytes(), 0);
  assert.equal(parts[0].text, `${renderDelivery(message(1, "first"))}\n\n${renderDelivery(message(2, "second"))}`);
  assert.deepEqual(await f.delivery.step(f.life.signal, parent, () => true), []);
  await f.delivery.idle(); assert.equal(patches.length, 1);
});

test("pre-attempt hook refusal and cancellation preserve owned input", async (t) => {
  let valid = true, refuse = true, attempts = 0;
  const f = setup(t, { status: async () => "busy", patch: async (part, _signal, attempted) => {
    if (refuse) { valid = false; assert.equal(attempted(), false); return false; }
    attempted(); attempts++; return part;
  } });
  await f.delivery.enqueue(f.life.signal, message(1));
  assert.deepEqual(await f.delivery.step(f.life.signal, parent, () => valid), []);
  assert.ok(f.bytes() > 0); assert.equal(attempts, 0);
  const cancel = new AbortController(); cancel.abort(new Error("before attempt"));
  await assert.rejects(f.delivery.step(cancel.signal, parent, () => true), /before attempt/);
  assert.ok(f.bytes() > 0);
  valid = true; refuse = false;
  await f.delivery.step(f.life.signal, parent, () => valid); assert.equal(attempts, 1); assert.equal(f.bytes(), 0);
});

test("lost or cancelled part response never replays through another hook or idle", async (t) => {
  let attempts = 0, status = "busy";
  const f = setup(t, { status: async () => status, patch: async (_part, signal, attempted) => {
    attempted(); attempts++; throw signal.reason || new Error("part response lost");
  } });
  await f.delivery.enqueue(f.life.signal, message(1));
  await assert.rejects(f.delivery.step(f.life.signal, parent, () => true), /response lost/);
  assert.equal(f.bytes(), 0); assert.deepEqual(await f.delivery.step(f.life.signal, parent, () => true), []);
  status = "idle"; await f.delivery.idle(); assert.equal(attempts, 1); assert.equal(f.submissions.length, 0);
});

test("hook and idle serialize claims; disposal joins an attempted part update", async (t) => {
  const entered = deferred(), release = deferred(); let attempts = 0, signal;
  const f = setup(t, { status: async () => "busy", patch: async (part, cancel, attempted) => {
    signal = cancel; attempted(); attempts++; entered.resolve(); await release.promise; throw cancel.reason;
  } });
  await f.delivery.enqueue(f.life.signal, message(1));
  const rejected = assert.rejects(f.delivery.step(f.life.signal, parent, () => true), /closed/);
  await entered.promise;
  const idle = assert.rejects(f.delivery.idle(), /closed/);
  f.life.abort(new Error("owner closed"));
  let joined = false;
  const disposing = f.delivery.dispose().then(() => { joined = true; });
  assert.equal(signal.aborted, true); assert.equal(joined, false);
  release.resolve(); await rejected; await idle; await disposing;
  assert.equal(attempts, 1); assert.equal(f.bytes(), 0); assert.equal(f.submissions.length, 0);
});

test("idle event while a hook owns an empty FIFO wakes later input before that hook joins", { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred(), submitted = deferred(); let status = "busy";
  const f = setup(t, { status: async () => status, patch: async (part, _signal, attempted) => {
    attempted(); entered.resolve(); await release.promise; return part;
  }, submit: async (parameters, _signal, attempted) => { attempted(); f.submissions.push(parameters); submitted.resolve(); } });
  await f.delivery.enqueue(f.life.signal, message(1));
  const step = f.delivery.step(f.life.signal, parent, () => true); await entered.promise;
  assert.equal(f.bytes(), 0);
  status = "idle"; const idle = f.delivery.idle();
  assert.equal((await f.delivery.enqueue(f.life.signal, message(2))).disposition, "queued_for_next_turn");
  release.resolve(); await step; await idle; await submitted.promise;
  assert.equal(f.submissions.length, 1); assert.match(f.submissions[0].parts[0].text, /message_2/); assert.doesNotMatch(f.submissions[0].parts[0].text, /message_1/);
});

test("stale part snapshots keep successful and uncertain batches ordered after authored bytes", async (t) => {
  const persisted = [], authored = { id: parent.after, text: "unaltered authored bytes" };
  let uncertain = false;
  const f = setup(t, { status: async () => "busy", patch: async (part, _signal, attempted) => {
    attempted(); persisted.push(structuredClone(part)); if (uncertain) throw new Error("persisted reply lost"); return part;
  } });
  for (let n = 0; n < 3; n++) {
    await f.delivery.enqueue(f.life.signal, message(n));
    uncertain = n === 1;
    if (uncertain) await assert.rejects(f.delivery.step(f.life.signal, parent, () => true), /reply lost/);
    else await f.delivery.step(f.life.signal, parent, () => true);
  }
  const reloaded = [authored, ...persisted].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  assert.equal(reloaded[0], authored);
  assert.deepEqual(reloaded.slice(1).map((p) => p.text), [0, 1, 2].map((n) => renderDelivery(message(n))));
  assert.deepEqual(await f.delivery.step(f.life.signal, parent, () => true), []);
  await f.delivery.idle(); assert.equal(f.submissions.length, 0);
  // A new parent does not inherit the old parent's exhausted upper floor.
  await f.delivery.enqueue(f.life.signal, message(3));
  const other = { ...parent, messageID: "msg_next", after: "prt_" };
  const [next] = await f.delivery.step(f.life.signal, other, () => true);
  assert.match(next.id, /^prt_000000000000[0-9A-Za-z]{14}$/u);
});

test("invalid or exhausted part bounds leave the unsent FIFO untouched", async (t) => {
  let patches = 0;
  const f = setup(t, { status: async () => "busy", patch: async (part, _signal, attempted) => { attempted(); patches++; return part; } });
  await f.delivery.enqueue(f.life.signal, message(1)); const bytes = f.bytes();
  for (const after of ["prt_é", `prt_${"~".repeat(252)}`]) {
    await assert.rejects(f.delivery.step(f.life.signal, { ...parent, after }, () => true), /unsupported|adapter ordering bound/);
    assert.equal(patches, 0); assert.equal(f.bytes(), bytes);
  }
  await f.delivery.step(f.life.signal, parent, () => true); assert.equal(patches, 1);
});

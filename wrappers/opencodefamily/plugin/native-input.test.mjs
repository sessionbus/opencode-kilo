// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { currentUser, inputHooks, inputRequest, orderedPartID } from "./native-input.mjs";
const user = (id, created, text = "authored", sessionID = "ses_root") => ({ info: { id, role: "user", sessionID, time: { created } }, parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text }] });
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
function part(request, id = orderedPartID(request.after)) { return { id, sessionID: request.sessionID, messageID: request.messageID, type: "text", text: "attributed bus input" }; }

test("current user follows native chronology through projection and equal-time IDs", () => {
  const earlier = user("msg_zz_imported", 9), a = user("msg_a", 10), b = user("msg_b", 10);
  assert.equal(currentUser([b, earlier, a]).message, b);
  assert.equal(currentUser([a, b, earlier]).message, b);
  assert.throws(() => currentUser([a, user("msg_other", 11, "", "ses_child")]), /mixes sessions/);
  assert.throws(() => currentUser([{ ...a, info: { ...a.info, time: { created: NaN } } }]), /malformed/);
  assert.throws(() => currentUser([]), /empty/);
  assert.throws(() => inputRequest({ operation: "step", sessionID: "ses_root", messageID: "msg_a", created: 10, token: "valid", extra: true }), /invalid/);
});

test("hook freezes the current user before concurrent human input and keeps authored parts", async () => {
  const entered = deferred(), release = deferred(), life = new AbortController(), original = user("msg_original", 10);
  let captured;
  const hooks = inputHooks(async (request) => {
    if (request.operation === "bind") return { token: request.messageID };
    captured = request; entered.resolve(); await release.promise; return { parts: [part(request)] };
  }, life.signal);
  await hooks["chat.message"]({ sessionID: "ses_root" }, { message: original.info });
  const messages = [original];
  const step = hooks["experimental.chat.messages.transform"]({}, { messages });
  await entered.promise;
  const human = user("msg_human", 11, "later human text"); messages.push(human);
  release.resolve(); await step;
  assert.equal(captured.messageID, original.info.id);
  assert.equal(captured.after, original.parts[0].id);
  assert.equal(original.parts[0].text, "authored"); assert.equal(original.parts.length, 2); assert.equal(human.parts.length, 1);
});

test("duplicate and prune hooks append only confirmed once-owned parts; reload retains history", async () => {
  const original = user("msg_original", 10), life = new AbortController(); let attempted = false, patches = 0;
  const persisted = [];
  const hooks = inputHooks(async (request) => {
    if (request.operation === "bind") return { token: "run_current" };
    if (attempted) return { parts: [] };
    attempted = true; patches++; const added = part(request); persisted.push(added); return { parts: [added] };
  }, life.signal);
  await hooks["chat.message"]({ sessionID: "ses_root" }, { message: original.info });
  for (let repeat = 0; repeat < 3; repeat++) await hooks["experimental.chat.messages.transform"]({}, { messages: [original] });
  const reloaded = user("msg_original", 10); reloaded.parts.push(...persisted); reloaded.parts.sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  await hooks["experimental.chat.messages.transform"]({}, { messages: [reloaded] });
  assert.equal(patches, 1); assert.deepEqual(original.parts, reloaded.parts);
});

test("part ID generation preserves ASCII byte order at equal entropy and bounded edges", () => {
  const entropy = (n) => Buffer.alloc(n);
  const native = `prt_${"f".repeat(11)}e${"z".repeat(14)}`;
  const one = orderedPartID(native, entropy), two = orderedPartID(one, entropy);
  assert.match(one, /^prt_ffffffffffff[0-9A-Za-z]{14}$/u);
  assert.ok(Buffer.compare(Buffer.from(one), Buffer.from(native)) > 0);
  assert.ok(Buffer.compare(Buffer.from(two), Buffer.from(one)) > 0); // no header wrap
  for (const floor of ["prt_", "prt_!", "prt_imported~", `prt_${"~".repeat(219)}!${"~".repeat(32)}`]) {
    const id = orderedPartID(floor, entropy);
    assert.ok(id.startsWith("prt_")); assert.ok(id.length <= 256); assert.ok(id > floor);
  }
  assert.throws(() => orderedPartID(`prt_${"~".repeat(252)}`, entropy), /adapter ordering bound/);
  for (const floor of ["prt_é", "prt_\u007f", "prt_ space", "bad", `prt_${"x".repeat(253)}`]) assert.throws(() => orderedPartID(floor, entropy), /unsupported/);
  const mixed = user("msg_part", 1); mixed.parts[0].messageID = "msg_foreign";
  assert.throws(() => currentUser([mixed]), /parent identities/);
});

test("older binds cannot overwrite a newer anchor and older contexts cannot claim input", async () => {
  const older = user("msg_old", 10), newer = user("msg_new", 11), delayed = deferred(), entered = deferred(); let steps = 0;
  const hooks = inputHooks(async (request) => {
    if (request.operation === "step") { steps++; assert.equal(request.token, newer.info.id); return { parts: [] }; }
    if (request.messageID === older.info.id) { entered.resolve(); await delayed.promise; }
    return { token: request.messageID };
  }, new AbortController().signal);
  const first = hooks["chat.message"]({ sessionID: "ses_root" }, { message: older.info }); await entered.promise;
  await hooks["chat.message"]({ sessionID: "ses_root" }, { message: newer.info }); delayed.resolve(); await first;
  await hooks["experimental.chat.messages.transform"]({}, { messages: [older] }); assert.equal(steps, 0);
  await hooks["experimental.chat.messages.transform"]({}, { messages: [older, newer] }); assert.equal(steps, 1);
});

test("refused bind does not redirect a child or an unrelated context", async () => {
  let steps = 0;
  const hooks = inputHooks(async (request) => request.operation === "bind" ? { token: null } : (steps++, { parts: [] }), new AbortController().signal);
  const child = user("msg_task", 1, "task", "ses_child");
  await hooks["chat.message"]({ sessionID: "ses_child" }, { message: child.info });
  await hooks["experimental.chat.messages.transform"]({}, { messages: [child] }); assert.equal(steps, 0);
  await assert.rejects(hooks["chat.message"]({ sessionID: "ses_root" }, { message: child.info }), /mixes sessions/);
});

test("private reply loss after native ownership is surfaced and never manufactures local context", async () => {
  let owned = true, attempts = 0;
  const original = user("msg_original", 10), hooks = inputHooks(async (request) => {
    if (request.operation === "bind") return { token: "run_current" };
    if (!owned) return { parts: [] };
    owned = false; attempts++; throw new Error("private response lost");
  }, new AbortController().signal);
  await hooks["chat.message"]({ sessionID: "ses_root" }, { message: original.info });
  await assert.rejects(hooks["experimental.chat.messages.transform"]({}, { messages: [original] }), /response lost/);
  await hooks["experimental.chat.messages.transform"]({}, { messages: [original] });
  assert.equal(attempts, 1); assert.equal(original.parts.length, 1);
});

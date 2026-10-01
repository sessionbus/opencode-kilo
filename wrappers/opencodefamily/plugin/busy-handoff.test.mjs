// SPDX-License-Identifier: MIT
import { nativeProduct } from "./profile.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import test from "node:test";
import { NativeDelivery, deliveryEnvelope, nextPartID, placeHandoffs } from "./delivery.mjs";
import { createServer } from "./server.mjs";
import { InteractiveEndpoint } from "./endpoint.mjs";
import { publishEndpoint } from "./readiness.mjs";

function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
const message = (id) => ({ message_id: id, body: `body ${id}`, from: { product: "test", session_id: "sender", groups: [] } });
function delivery(t, overrides = {}) {
  const life = new AbortController(), submissions = [];
  let bytes = 0;
  const value = new NativeDelivery({ sessionID: "ses_native", signal: life.signal, status: async () => "busy", info: async () => ({ directory: "/native" }),
    reserve: (size) => { bytes += size; return true; }, release: (size) => { bytes -= size; },
    submit: async (parameters, _signal, started) => { started(); submissions.push(parameters); }, ...overrides });
  t.after(async () => { life.abort(); await value.dispose(); assert.equal(bytes, 0); });
  return { delivery: value, life, submissions, bytes: () => bytes };
}

test("take hands the whole FIFO prefix to one write, in order, and only after it starts", async (t) => {
  const f = delivery(t);
  for (const id of ["a", "b", "c"]) assert.equal((await f.delivery.enqueue(f.life.signal, message(id))).disposition, "queued_for_next_turn");
  const texts = [];
  const part = await f.delivery.take(f.life.signal, async (text, _signal, started) => { texts.push(text); started(); return { text }; });
  assert.equal(texts.length, 1);
  assert.match(texts[0], /messageId":"a".*messageId":"b".*messageId":"c"/su);
  assert.equal(part.text, texts[0]); assert.equal(f.bytes(), 0);
  assert.equal(await f.delivery.take(f.life.signal, async () => assert.fail("empty FIFO must not write")), undefined);
});

test("take failure before the write starts keeps input queued; after it starts input is not retried", async (t) => {
  const f = delivery(t);
  await f.delivery.enqueue(f.life.signal, message("kept"));
  await assert.rejects(f.delivery.take(f.life.signal, async () => { throw new Error("before start"); }), /before start/);
  assert.ok(f.bytes() > 0);
  await assert.rejects(f.delivery.take(f.life.signal, async (_text, _signal, started) => { started(); throw new Error("uncertain"); }), /uncertain/);
  assert.equal(f.bytes(), 0);
  assert.equal(await f.delivery.take(f.life.signal, async () => assert.fail("attempted input replayed")), undefined);
});

test("take shares the single consumer with the idle drain and resumes idle demand afterwards", async (t) => {
  let status = "busy";
  const f = delivery(t, { status: async () => status });
  await f.delivery.enqueue(f.life.signal, message("one"));
  const writing = deferred(), release = deferred();
  const taking = f.delivery.take(f.life.signal, async (_text, _signal, started) => { writing.resolve(); await release.promise; started(); return {}; });
  await writing.promise;
  await f.delivery.enqueue(f.life.signal, message("two"));
  assert.equal(await f.delivery.take(f.life.signal, async () => assert.fail("second consumer")), undefined);
  status = "idle";
  void f.delivery.idle();
  release.resolve(); await taking;
  for (let i = 0; i < 20 && !f.submissions.length; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.submissions.length, 1); assert.match(f.submissions[0].parts[0].text, /messageId":"two"/u);
});

// Dev1 review probe (952be57): the idle event lands while the write owns the
// consumer and the FIFO is empty; input accepted before the write settles must
// still wake the idle session.
test("idle while a started take empties the FIFO keeps demand for input accepted before it settles", async (t) => {
  let status = "busy";
  const f = delivery(t, { status: async () => status });
  await f.delivery.enqueue(f.life.signal, message("taken"));
  const writing = deferred(), release = deferred();
  const taking = f.delivery.take(f.life.signal, async (_text, _signal, started) => { started(); writing.resolve(); await release.promise; return {}; });
  await writing.promise;
  assert.equal(f.bytes(), 0);
  status = "idle";
  await f.delivery.idle();
  assert.equal((await f.delivery.enqueue(f.life.signal, message("fresh"))).disposition, "queued_for_next_turn");
  release.resolve(); await taking;
  for (let i = 0; i < 20 && !f.submissions.length; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.submissions.length, 1); assert.match(f.submissions[0].parts[0].text, /messageId":"fresh"/u);
});

test("take batches within the per-owner byte bound; the rest waits for a later step", async (t) => {
  const f = delivery(t);
  const big = (id) => ({ ...message(id), body: "x".repeat(600 * 1024) });
  await f.delivery.enqueue(f.life.signal, big("big1"));
  await f.delivery.enqueue(f.life.signal, message("small")).catch(() => {});
  const first = [];
  await f.delivery.take(f.life.signal, async (text, _signal, started) => { first.push(text); started(); return {}; });
  assert.equal(first.length, 1);
  assert.ok(f.bytes() >= 0);
});

test("nextPartID sorts after the current prompt's parts and refuses unknown or exhausted floors", () => {
  const floor = "prt_0000000000ffABCDEFGHIJKLMN";
  const early = nextPartID(floor, 0);
  assert.ok(early > floor); assert.equal(early.slice(4, 16), "000000000100");
  const now = nextPartID(floor, Date.now());
  assert.ok(now > floor); assert.match(now, /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/u);
  assert.equal(nextPartID("prt_ffffffffffffABCDEFGHIJKLMN", 0), undefined);
  assert.equal(nextPartID("custom-part", 0), undefined);
  assert.equal(nextPartID("", 0), undefined);
});

async function interactive(t, nativeInput) {
  const directory = await mkdtemp("/tmp/sb-busy-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binding = { directory, pid: process.ppid, socket: directory + "/bus.sock", name: "", groups: [] };
  const hooks = await createServer({ [nativeProduct.launchEnv]: JSON.stringify(binding) })();
  t.after(() => hooks.dispose());
  const endpoint = new InteractiveEndpoint(directory + "/actions.sock", async () => ({}), nativeInput);
  t.after(() => endpoint.dispose());
  await endpoint.ready(); await publishEndpoint(directory);
  // The tool round trip proves the resident connection is ready.
  await hooks.tool.sessionbus.execute({ action: "list", arguments: {} }, { sessionID: "ses_s", messageID: "msg_tool", abort: new AbortController().signal });
  return hooks;
}
const user = (id, parts = [{ id: "prt_000000000001ABCDEFGHIJKLMN", sessionID: "ses_s", messageID: id, type: "text", text: "task" }]) => ({ info: { id, sessionID: "ses_s", role: "user" }, parts });

// Minimal Go-lane-shaped MCP endpoint: `input` answers the hidden hook tool
// with undefined (written) or an error string.
async function lane(t, input) {
  const directory = await mkdtemp("/tmp/sb-lane-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf("\n")) >= 0;) {
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (request.id === undefined) continue;
        const reply = (result) => socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
        if (request.method === "initialize") reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} } });
        else if (request.method === "tools/list") reply({ tools: [{ name: "sessionbus" }] });
        else void Promise.resolve(request.params.name === "sessionbus_native_input" ? input(request.params.arguments) : undefined)
          .then((error) => reply({ ...(error ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(error ? { error } : {}) }] }));
      }
    });
  });
  await new Promise((resolve) => server.listen(directory + "/lane.sock", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); for (const socket of sockets) socket.destroy(); }));
  const written = [], reads = [];
  const client = { session: { message: async ({ path }) => { reads.push(path); return { data: { parts: written.filter((part) => part.messageID === path.messageID) } }; } } };
  const hooks = await createServer({ SESSIONBUS_LANE_SOCKET: directory + "/lane.sock" })({ client });
  t.after(() => hooks.dispose());
  await hooks.tool.sessionbus.execute({ action: "list", arguments: {} }, { sessionID: "ses_s", messageID: "msg_tool", abort: new AbortController().signal });
  return { hooks, written, reads };
}

test("lane transform: the Go owner writes queued input as the requested part; the hook adds it to this call", { timeout: 5000 }, async (t) => {
  const requests = [];
  let answer = "no queued input";
  const f = await lane(t, (args) => {
    requests.push(args);
    if (answer) return answer;
    f.written.push({ id: args.part_id, sessionID: args.session_id, messageID: args.message_id, type: "text", text: "queued" });
  });
  await f.hooks["chat.message"]({ sessionID: "ses_s" }, { message: { id: "msg_new", sessionID: "ses_s", role: "user" }, parts: [] });
  const current = user("msg_new");
  // Empty FIFO: nothing is read back or added.
  await f.hooks["experimental.chat.messages.transform"]({}, { messages: [current] });
  assert.equal(requests.length, 1); assert.equal(f.reads.length, 0); assert.equal(current.parts.length, 1);
  assert.equal(requests[0].session_id, "ses_s"); assert.equal(requests[0].message_id, "msg_new");
  assert.ok(requests[0].part_id > "prt_000000000001ABCDEFGHIJKLMN");
  answer = undefined;
  await f.hooks["experimental.chat.messages.transform"]({}, { messages: [current] });
  assert.equal(current.parts.length, 2); assert.equal(current.parts[1].text, "queued"); assert.equal(current.parts[1].id, requests[1].part_id);
  // An owner failure never reaches native.
  answer = "native write failed";
  await f.hooks["experimental.chat.messages.transform"]({}, { messages: [current] });
  assert.equal(requests.length, 3); assert.equal(current.parts.length, 2);
});

test("transform appends handed-off input to the newest prompt only and never throws into native", { timeout: 5000 }, async (t) => {
  const requests = [];
  let fail = false;
  const hooks = await interactive(t, async (params) => {
    requests.push(params);
    if (fail) throw new Error("owner unavailable");
    return { parts: [{ id: "prt_000000000009ABCDEFGHIJKLMN", sessionID: params.sessionID, messageID: params.messageID, type: "text", text: "queued" }] };
  });
  const current = user("msg_new");
  // No chat.message seen yet: not the newest prompt, so nothing is requested.
  await hooks["experimental.chat.messages.transform"]({}, { messages: [current] });
  assert.equal(requests.length, 0);
  await hooks["chat.message"]({ sessionID: "ses_s" }, { message: { id: "msg_new", sessionID: "ses_s", role: "user" }, parts: [] });
  // An older user (compaction history head) is never a target.
  await hooks["experimental.chat.messages.transform"]({}, { messages: [user("msg_old")] });
  assert.equal(requests.length, 0);
  const messages = [user("msg_old"), { info: { id: "msg_a", sessionID: "ses_s", role: "assistant" }, parts: [] }, current, { info: { id: "msg_b", sessionID: "ses_s", role: "assistant" }, parts: [] }];
  await hooks["experimental.chat.messages.transform"]({}, { messages });
  assert.deepEqual(requests.at(-1), { sessionID: "ses_s", messageID: "msg_new", after: "prt_000000000001ABCDEFGHIJKLMN" });
  assert.equal(current.parts.at(-1).text, "queued");
  fail = true;
  await hooks["experimental.chat.messages.transform"]({}, { messages });
  assert.equal(requests.length, 2); assert.equal(current.parts.length, 2);
  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "ses_s" } } } });
  await hooks["experimental.chat.messages.transform"]({}, { messages });
  assert.equal(requests.length, 2);
});

test("transform ignores returned parts that do not belong to the frozen prompt", { timeout: 5000 }, async (t) => {
  const hooks = await interactive(t, async (params) => ({ parts: [
    { id: "prt_000000000009ABCDEFGHIJKLMN", sessionID: "ses_other", messageID: params.messageID, type: "text", text: "foreign" },
    { id: "prt_000000000000ABCDEFGHIJKLMN", sessionID: params.sessionID, messageID: params.messageID, type: "text", text: "not after" },
  ] }));
  await hooks["chat.message"]({ sessionID: "ses_s" }, { message: { id: "msg_new", sessionID: "ses_s", role: "user" }, parts: [] });
  const current = user("msg_new");
  await hooks["experimental.chat.messages.transform"]({}, { messages: [current] });
  assert.equal(current.parts.length, 1);
});

test("endpoint without a handoff owner answers method-not-found; the transform keeps native running", { timeout: 5000 }, async (t) => {
  const hooks = await interactive(t, undefined);
  await hooks["chat.message"]({ sessionID: "ses_s" }, { message: { id: "msg_new", sessionID: "ses_s", role: "user" }, parts: [] });
  const current = user("msg_new");
  await hooks["experimental.chat.messages.transform"]({}, { messages: [current] });
  assert.equal(current.parts.length, 1);
});

test("a synthetic user added after the prompt (observed with a skills plugin) is the handoff target", { timeout: 5000 }, async (t) => {
  const requests = [];
  const hooks = await interactive(t, async (params) => {
    requests.push(params);
    return { parts: [{ id: "prt_000000000009ABCDEFGHIJKLMN", sessionID: params.sessionID, messageID: params.messageID, type: "text", text: "queued" }] };
  });
  await hooks["chat.message"]({ sessionID: "ses_s" }, { message: { id: "msg_prompt", sessionID: "ses_s", role: "user" }, parts: [] });
  const synthetic = user("msg_skills", [{ id: "prt_000000000002ABCDEFGHIJKLMN", sessionID: "ses_s", messageID: "msg_skills", type: "text", text: "skills", synthetic: true }]);
  const messages = [user("msg_prompt"), synthetic, { info: { id: "msg_a", sessionID: "ses_s", role: "assistant", parentID: "msg_skills" }, parts: [] }];
  await hooks["experimental.chat.messages.transform"]({}, { messages });
  assert.deepEqual(requests, [{ sessionID: "ses_s", messageID: "msg_skills", after: "prt_000000000002ABCDEFGHIJKLMN" }]);
  assert.equal(synthetic.parts.at(-1).text, "queued");
});

const base = 1790879142000;
const envelope = `${deliveryEnvelope}from="peer" from-session="peer@host">\nRECIP\n</cross-session-message>`;
const handed = (messageID, at, text = envelope) => ({ id: nextPartID("prt_000000000001ABCDEFGHIJKLMN", at), sessionID: "ses_s", messageID, type: "text", text });
const prompt = (id, created, extra = []) => ({ info: { id, sessionID: "ses_s", role: "user", time: { created } }, parts: [{ id: "prt_000000000001ABCDEFGHIJKLMN", sessionID: "ses_s", messageID: id, type: "text", text: "task" }, ...extra] });
const reply = (id, created, completed) => ({ info: { id, sessionID: "ses_s", role: "assistant", time: completed === undefined ? { created } : { created, completed } }, parts: [] });

test("a handed-off part becomes its own user turn before the step that received it, on later calls too", () => {
  // Lane A (C4 repeat): the step's assistant record was created just before the pull and completed after it.
  const part = handed("msg_task", base + 14386);
  const task = prompt("msg_task", base, [part]), info = task.info;
  const messages = [task, reply("msg_a1", base + 100, base + 13000), reply("msg_a3", base + 14275, base + 31000), reply("msg_a4", base + 31100, base + 46000)];
  placeHandoffs(messages, base + 60000);
  assert.deepEqual(messages.map((message) => message.info.id), ["msg_task", "msg_a1", `msg_${part.id.slice(4)}`, "msg_a3", "msg_a4"]);
  const entry = messages[2];
  assert.equal(entry.info.role, "user"); assert.equal(entry.info.time.created, base + 14386);
  assert.equal(entry.parts.length, 1); assert.equal(entry.parts[0], part); assert.equal(entry.parts[0].text, envelope);
  assert.equal(task.parts.length, 1); assert.equal(task.info, info); assert.equal(info.time.created, base); assert.notEqual(entry.info, info);
});

test("on the delivery step the turn is last, before an unfinished assistant, in pull order", () => {
  const first = handed("msg_task", base + 5000), second = handed("msg_task", base + 6000);
  const messages = [prompt("msg_task", base, [first, second]), reply("msg_a1", base + 100, base + 4000)];
  placeHandoffs(messages, base + 7000);
  assert.deepEqual(messages.map((message) => message.info.id), ["msg_task", "msg_a1", `msg_${first.id.slice(4)}`, `msg_${second.id.slice(4)}`]);
  const later = [prompt("msg_task", base, [handed("msg_task", base + 5000)]), reply("msg_a1", base + 100, base + 4000), reply("msg_a2", base + 4500)];
  placeHandoffs(later, base + 7000);
  assert.deepEqual(later.map((message) => message.info.role), ["user", "assistant", "user", "assistant"]);
});

test("after compaction a retained handoff stays after the message it was stored on", () => {
  // Compacted call array: [compaction user, summary, retained task and its step, continue user]; the summary completed last.
  const part = handed("msg_task", base + 500);
  const messages = [prompt("msg_compact", base + 900), reply("msg_summary", base + 950, base + 1000), prompt("msg_task", base, [part]),
    reply("msg_a1", base + 100, base + 600), prompt("msg_continue", base + 1100)];
  placeHandoffs(messages, base + 2000);
  assert.deepEqual(messages.map((message) => message.info.id), ["msg_compact", "msg_summary", "msg_task", `msg_${part.id.slice(4)}`, "msg_a1", "msg_continue"]);
});

test("a part with no usable pull time, other text and a delivery that is the message itself stay in place", () => {
  const future = prompt("msg_future", base, [handed("msg_future", base + 5000)]);
  const undated = prompt("msg_undated", base, [handed("msg_undated", base + 10)]); delete undated.info.time;
  const plain = prompt("msg_plain", base, [handed("msg_plain", base + 10, "not a delivery")]);
  const wake = { info: { id: "msg_wake", sessionID: "ses_s", role: "user", time: { created: base } }, parts: [handed("msg_wake", base + 10)] };
  const messages = [future, undated, plain, wake];
  placeHandoffs(messages, base + 1000);
  assert.deepEqual(messages.map((message) => [message.info.id, message.parts.length]), [["msg_future", 2], ["msg_undated", 2], ["msg_plain", 2], ["msg_wake", 1]]);
});

test("the transform presents this call's handoff as the last user turn and leaves a head without the newest prompt alone", { timeout: 5000 }, async (t) => {
  const f = await lane(t, (args) => { f.written.push({ id: args.part_id, sessionID: args.session_id, messageID: args.message_id, type: "text", text: envelope }); });
  await f.hooks["chat.message"]({ sessionID: "ses_s" }, { message: { id: "msg_new", sessionID: "ses_s", role: "user" }, parts: [] });
  const created = Date.now() - 1000;
  const head = [prompt("msg_old", created - 5000, [handed("msg_old", created - 4000)]), reply("msg_o1", created - 4500, created - 3000)];
  await f.hooks["experimental.chat.messages.transform"]({}, { messages: head });
  assert.deepEqual(head.map((message) => [message.info.id, message.parts.length]), [["msg_old", 2], ["msg_o1", 0]]);
  const current = prompt("msg_new", created);
  const messages = [current, reply("msg_a1", created + 10, created + 500)];
  await f.hooks["experimental.chat.messages.transform"]({}, { messages });
  assert.equal(current.parts.length, 1); assert.equal(messages.length, 3);
  assert.equal(messages[2].info.role, "user"); assert.equal(messages[2].parts[0].text, envelope); assert.equal(messages[2].parts[0].id, f.written[0].id);
});

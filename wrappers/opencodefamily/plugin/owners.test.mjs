// SPDX-License-Identifier: MIT
import { nativeProduct } from "./profile.mjs";

import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Connection } from "@sessionbus/kit";
import { NativeOwners } from "./owners.mjs";
import { InteractiveEndpoint } from "./endpoint.mjs";
import { SessionbusForwarder } from "./forward.mjs";
import { inputHooks } from "./native-input.mjs";

function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
const result = (data, status = 200) => ({ data, response: { status } });
const info = (id, title = "") => ({ id, title, directory: "/native/project" });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oc-own-"));
  const sockets = new Set(), wires = new Map(), calls = [], updates = [], failures = [];
  const hello = new EventEmitter(), events = new EventEmitter();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    let id;
    const connection = new Connection(socket, false, (request) => {
      void (async () => {
        if (request.method === "session.hello") {
          id = request.params.session_id; wires.set(id, connection); hello.emit(id, request.params);
          if (options.hello) await options.hello(connection, request);
          else await connection.result(request, {});
        } else {
          calls.push({ nativeID: id, ...request });
          if (options.call) await options.call(connection, request, id);
          else await connection.result(request, { sessions: [] });
        }
      })().catch((error) => connection.close(error));
    });
  });
  const socket = path.join(directory, "bus");
  server.listen(socket); await once(server, "listening");
  const api = { event: { on(type, handler) { events.on(type, handler); return () => events.off(type, handler); } }, client: { session: {
    async get(params, config) {
      assert.deepEqual(Object.keys(params), ["sessionID"]);
      assert.equal(config.throwOnError, true); assert.equal(config.redirect, "error");
      return options.get ? options.get(params, config) : result(info(params.sessionID));
    },
    async status(params, config) { return options.status ? options.status(params, config) : result({}); },
    async messages(params, config) { return options.messages ? options.messages(params, config) : result([]); },
    async update(params, config) { updates.push(params); return options.update ? options.update(params, config) : result(info(params.sessionID, params.title)); },
    async promptAsync(params, config) {
      if (!options.promptAsync) throw new Error("unexpected model input");
      assert.equal(config.throwOnError, true); assert.equal(config.redirect, "error");
      return options.promptAsync(params, config);
    },
  }, part: { update: (params, config) => options.part ? options.part(params, config) : result(params.part) }, permission: { list: (params, config) => options.permission ? options.permission(params, config) : result([]) },
    question: { list: (params, config) => options.question ? options.question(params, config) : result([]) },
  }, state: { session: {
    permission: (id) => options.livePermission?.(id) || [], question: (id) => options.liveQuestion?.(id) || [],
  } } };
  const owners = new NativeOwners(api, { socket, groups: ["group"], name: options.name || "" }, { report: (error) => { failures.push(error); options.report?.(error); }, peer: options.peer });
  t.after(async () => {
    await owners.dispose();
    for (const stream of sockets) stream.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const action = (id, signal = new AbortController().signal) => owners.action("list", {}, { sessionID: id, messageID: "msg_native", signal });
  return { owners, events, hello, wires, calls, updates, failures, action, sockets, directory };
}

test("native tool can establish unselected exact child; only first route elects name", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { name: "initial" });
  await f.action("ses_child");
  assert.equal(f.calls[0].nativeID, "ses_child");
  assert.deepEqual(f.updates, []);
  await f.owners.select("ses_selected");
  await f.owners.select("ses_later");
  assert.deepEqual(f.updates, [{ sessionID: "ses_selected", title: "initial" }]);
  assert.equal(f.wires.size, 3, "navigation retains established owners");
});

test("delayed native old-ID call remains old after route changes", { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { get: async ({ sessionID }) => {
    if (sessionID === "ses_old") { entered.resolve(); await release.promise; }
    return result(info(sessionID));
  } });
  const old = f.action("ses_old");
  await entered.promise;
  await f.owners.select("ses_new");
  await f.action("ses_new");
  release.resolve(); await old;
  assert.deepEqual(f.calls.map((call) => call.nativeID), ["ses_new", "ses_old"]);
});

test("deletion during held native GET forbids late owner resurrection", { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred();
  let signal;
  const f = await fixture(t, { get: async ({ sessionID }, options) => {
    signal = options.signal; entered.resolve(); await release.promise;
    return result(info(sessionID)); // Deliberately late native completion.
  } });
  const action = assert.rejects(f.action("ses_deleted"), /deleted/);
  await entered.promise;
  f.events.emit("session.deleted", { properties: { info: { id: "ses_deleted" } } });
  assert.equal(signal.aborted, true);
  release.resolve(); await action;
  await f.owners.dispose();
  assert.equal(f.wires.size, 0);
  assert.equal(f.calls.length, 0);
});

test("deletion during actual kit hello closes its owner before admission", { timeout: 5000 }, async (t) => {
  const entered = deferred();
  const f = await fixture(t, { hello: async () => { entered.resolve(); } });
  const action = assert.rejects(f.action("ses_held"), /deleted/);
  await entered.promise;
  const wire = f.wires.get("ses_held");
  const closed = once(wire.stream, "close");
  f.events.emit("session.deleted", { properties: { info: { id: "ses_held" } } });
  await action; await closed; await f.owners.dispose();
  assert.equal(f.calls.length, 0);
});

test("native TUI disposal joins pending native GET, even if abort response is delayed", { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred();
  let signal;
  const f = await fixture(t, { get: async ({ sessionID }, options) => {
    signal = options.signal; entered.resolve(); await release.promise; return result(info(sessionID));
  } });
  const action = assert.rejects(f.action("ses_held"), /disposed/);
  await entered.promise;
  let disposed = false;
  const closing = f.owners.dispose().then(() => { disposed = true; });
  assert.equal(signal.aborted, true); assert.equal(disposed, false);
  release.resolve(); await closing; await action;
  assert.equal(f.wires.size, 0);
});

test("initial native status query completes before first hello", { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { status: async () => {
    entered.resolve(); await release.promise; return result({ ses_busy: { type: "busy" } });
  } });
  const action = f.action("ses_busy");
  await entered.promise; assert.equal(f.wires.size, 0);
  release.resolve(); await action;
  assert.equal(f.wires.size, 1);
});

test("native blank title stays absent; same-ID title updates use rehello", { timeout: 5000 }, async (t) => {
  const firstHello = deferred();
  const f = await fixture(t, { hello: async (wire, request) => {
    firstHello.resolve(request.params); await wire.result(request, {});
  } });
  await f.action("ses_title");
  assert.equal((await firstHello.promise).product, {
    "@sessionbus/opencode": "opencode-peer", "@sessionbus/kilo": "kilo-peer",
  }[nativeProduct.packageName]);
  assert.equal(Object.hasOwn(await firstHello.promise, "name"), false);
  const wire = f.wires.get("ses_title");
  const renamed = once(f.hello, "ses_title");
  f.events.emit("session.updated", { properties: { info: info("ses_title", "native title") } });
  const renamedIdentity = (await renamed)[0];
  assert.equal(renamedIdentity.name, "native title");
  assert.equal(renamedIdentity.product, (await firstHello.promise).product);
  assert.equal(f.wires.get("ses_title"), wire);
  const blank = once(f.hello, "ses_title");
  f.events.emit("session.updated", { properties: { info: info("ses_title", "") } });
  assert.equal(Object.hasOwn((await blank)[0], "name"), false);
});

test("pending identity bound rejects seventeenth owner without native call", { timeout: 5000 }, async (t) => {
  const release = deferred(); let calls = 0;
  const f = await fixture(t, { get: async ({ sessionID }) => { calls++; await release.promise; return result(info(sessionID)); } });
  const pending = Array.from({ length: 16 }, (_, index) => f.action(`ses_${index}`));
  await assert.rejects(f.action("ses_overflow"), /owner limit/);
  release.resolve(); await Promise.all(pending);
  assert.equal(calls, 16);
});

test("invalid native title update retires old identity and joins without self-wait", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.action("ses_title");
  const wire = f.wires.get("ses_title"), closed = once(wire.stream, "close");
  f.events.emit("session.updated", { properties: { info: info("ses_title", "invalid\nname") } });
  await closed;
  await f.owners.dispose();
  assert.ok(f.failures.some((error) => /identity grammar/.test(error.message)));
});

test("retiring owner keeps capacity until held native delivery actually joins", { timeout: 10000 }, async (t) => {
  const entered = deferred(), release = deferred();
  let hold = false, signal;
  const f = await fixture(t, { status: async (_params, options) => {
    if (hold) { signal = options.signal; entered.resolve(); await release.promise; }
    return result({});
  } });
  for (let index = 0; index < 128; index++) await f.action(`ses_${index}`);
  hold = true;
  const wire = f.wires.get("ses_0");
  const delivery = wire.call("message.deliver", { message_id: "delivery", body: "hello", from: { session_id: "sender", product: "test", groups: [] } }).catch((error) => error);
  await entered.promise;
  f.events.emit("session.deleted", { properties: { info: { id: "ses_0" } } });
  assert.equal(signal.aborted, true);
  await assert.rejects(f.action("ses_overflow"), /owner limit/);
  release.resolve(); await delivery; await f.owners.dispose();
});

for (const boundary of ["route", "deletion"]) {
  test(`actual endpoint native metadata survives held GET and ${boundary}`, { timeout: 5000 }, async (t) => {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, { get: async ({ sessionID }) => {
      if (sessionID === "ses_old") { entered.resolve(); await release.promise; }
      return result(info(sessionID));
    } });
    const socket = path.join(f.directory, "actions");
    const endpoint = new InteractiveEndpoint(socket, (action, args, context) => f.owners.action(action, args, context));
    await endpoint.ready();
    const client = new SessionbusForwarder(socket);
    t.after(async () => { await client.dispose(); await endpoint.dispose(); });
    const request = client.action("list", {}, { sessionID: "ses_old", messageID: "msg_actual_old" });
    const completion = boundary === "deletion" ? assert.rejects(request, /deleted/) : request;
    await entered.promise;
    await f.owners.select("ses_new");
    if (boundary === "deletion") f.events.emit("session.deleted", { properties: { info: { id: "ses_old" } } });
    release.resolve(); await completion;
    assert.deepEqual(f.calls.map((call) => call.nativeID), boundary === "deletion" ? [] : ["ses_old"]);
    await client.dispose(); await endpoint.dispose();
  });
}

test("deletion during initial native rename cannot rehello late title", { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { name: "first", update: async ({ sessionID, title }) => {
    entered.resolve(); await release.promise; return result(info(sessionID, title));
  } });
  const selecting = assert.rejects(f.owners.select("ses_initial"), /deleted/);
  await entered.promise;
  const wire = f.wires.get("ses_initial"), closed = once(wire.stream, "close");
  f.events.emit("session.deleted", { properties: { info: { id: "ses_initial" } } });
  release.resolve(); await selecting; await closed;
  await f.owners.select("ses_later");
  assert.deepEqual(f.updates, [{ sessionID: "ses_initial", title: "first" }]);
});

test("actual sole Caller preserves originating self_info with filtered rows", { timeout: 5000 }, async (t) => {
  const value = { sessions: [], self_info: { session_id: "ses_native@host", product: nativeProduct.product, groups: ["group"] } };
  const f = await fixture(t, { call: (wire, request) => wire.result(request, value) });
  assert.deepEqual(await f.action("ses_native"), value);
});

const inbound = (id = "blocker_delivery") => ({ message_id: id, body: "inbound", from: { session_id: "sender", product: "test", groups: [] } });
for (const type of ["question", "permission"]) {
  test(`Kilo initial ${type} snapshot blocks despite empty TUI maps; terminal event drains once`, { skip: !nativeProduct.blockers, timeout: 5000 }, async (t) => {
    let pending = true, submissions = 0, lists = 0;
    const submitted = deferred();
    const f = await fixture(t, { [type]: async (params, config) => {
      lists++; assert.deepEqual(params, { directory: "/native/project" });
      assert.equal(config.throwOnError, true); assert.equal(config.redirect, "error");
      return result(pending ? [{ id: "native_request", sessionID: "ses_blocked" }] : []);
    }, promptAsync: async (params) => {
      submissions++; assert.equal(params.sessionID, "ses_blocked");
      assert.equal(Object.hasOwn(params, "messageID"), false);
      submitted.resolve(); return result(undefined, 204);
    } });
    await f.action("ses_blocked");
    const receipt = await f.wires.get("ses_blocked").call("message.deliver", inbound());
    assert.equal(receipt.disposition, "queued_for_next_turn");
    assert.equal(submissions, 0); assert.equal(lists, 1);
    pending = false;
    f.events.emit(`${type}.replied`, { properties: { sessionID: "ses_blocked", requestID: "native_request" } });
    await submitted.promise; await f.owners.dispose();
    assert.equal(submissions, 1);
  });
}

test("Kilo another native session's pending question does not block the exact delivery owner", { skip: !nativeProduct.blockers, timeout: 5000 }, async (t) => {
  let submissions = 0;
  const f = await fixture(t, { question: async () => result([{ sessionID: "ses_other" }]),
    promptAsync: async (params) => { submissions++; assert.equal(params.sessionID, "ses_target"); return result(undefined, 204); },
  });
  await f.action("ses_target"); await f.owners.select("ses_other");
  assert.equal((await f.wires.get("ses_target").call("message.deliver", inbound())).disposition, "written");
  assert.equal(submissions, 1);
});

test("Kilo blocker arriving during held delivery GET preserves unsent input", { skip: !nativeProduct.blockers, timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred(), submitted = deferred();
  let hold = false, pending = false, submissions = 0;
  const f = await fixture(t, { get: async ({ sessionID }) => {
    if (hold) { hold = false; entered.resolve(); await release.promise; }
    return result(info(sessionID));
  }, question: async () => result(pending ? [{ sessionID: "ses_target" }] : []),
    promptAsync: async () => { submissions++; submitted.resolve(); return result(undefined, 204); },
  });
  await f.action("ses_target"); hold = true;
  const delivering = f.wires.get("ses_target").call("message.deliver", inbound());
  await entered.promise; pending = true;
  f.events.emit("question.asked", { properties: { sessionID: "ses_target", id: "native_question" } });
  release.resolve();
  assert.equal((await delivering).disposition, "queued_for_next_turn"); assert.equal(submissions, 0);
  pending = false;
  f.events.emit("question.rejected", { properties: { sessionID: "ses_target", requestID: "native_question" } });
  await submitted.promise; await f.owners.dispose(); assert.equal(submissions, 1);
});

test("Kilo final invocation recheck catches a blocker crossing the earlier live check", { skip: !nativeProduct.blockers, timeout: 5000 }, async (t) => {
  let checks = 0, pending = false, submissions = 0;
  const submitted = deferred();
  const f = await fixture(t, { liveQuestion: () => {
    checks++;
    // First check follows the snapshots, second follows GET. Native event/state
    // becomes visible in the microtask before the owned HTTP invocation runs.
    if (checks === 2) queueMicrotask(() => { pending = true; });
    return pending ? [{ sessionID: "ses_target" }] : [];
  }, promptAsync: async () => { submissions++; submitted.resolve(); return result(undefined, 204); } });
  await f.action("ses_target");
  assert.equal((await f.wires.get("ses_target").call("message.deliver", inbound())).disposition, "queued_for_next_turn");
  assert.equal(submissions, 0); assert.ok(checks >= 3);
  pending = false;
  f.events.emit("question.replied", { properties: { sessionID: "ses_target", requestID: "q" } });
  await submitted.promise; await f.owners.dispose(); assert.equal(submissions, 1);
});

test("Kilo deletion cancels and joins held pending-request snapshots without submission", { skip: !nativeProduct.blockers, timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred();
  let signal, submissions = 0;
  const f = await fixture(t, { permission: async (_params, options) => {
    signal = options.signal; entered.resolve(); await release.promise; return result([]);
  }, promptAsync: async () => { submissions++; return result(undefined, 204); } });
  await f.action("ses_target");
  const delivering = f.wires.get("ses_target").call("message.deliver", inbound()).catch((error) => error);
  await entered.promise;
  f.events.emit("session.deleted", { properties: { info: { id: "ses_target" } } });
  assert.equal(signal.aborted, true);
  let joined = false; const closing = f.owners.dispose().then(() => { joined = true; });
  await Promise.resolve(); assert.equal(joined, false);
  release.resolve(); await closing; await delivering; assert.equal(submissions, 0);
});

test("Kilo idle event during blocker snapshot cannot turn a stale snapshot into admission", { skip: !nativeProduct.blockers, timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred(); let initial = true, pending = false, submissions = 0;
  const f = await fixture(t, { question: async () => {
    if (initial) { initial = false; entered.resolve(); await release.promise; return result([]); }
    return result(pending ? [{ sessionID: "ses_target" }] : []);
  }, promptAsync: async () => { submissions++; return result(undefined, 204); } });
  await f.action("ses_target");
  const delivering = f.wires.get("ses_target").call("message.deliver", inbound());
  await entered.promise; pending = true;
  f.events.emit("question.asked", { properties: { sessionID: "ses_target", id: "q" } });
  f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "idle" } } });
  release.resolve();
  assert.equal((await delivering).disposition, "queued_for_next_turn"); assert.equal(submissions, 0);
});

test("Kilo native busy event during pending-request snapshots prevents handoff", { skip: !nativeProduct.blockers, timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred(); let submissions = 0;
  const f = await fixture(t, { question: async () => { entered.resolve(); await release.promise; return result([]); },
    promptAsync: async () => { submissions++; return result(undefined, 204); },
  });
  await f.action("ses_target");
  const delivering = f.wires.get("ses_target").call("message.deliver", inbound());
  await entered.promise;
  f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "busy" } } });
  release.resolve();
  assert.equal((await delivering).disposition, "queued_for_next_turn"); assert.equal(submissions, 0);
});

for (const bad of [result({}), result([{ sessionID: "wrong" }]), { error: new Error("native list failed"), response: { status: 500 } }]) {
  test(`Kilo unknown pending-request state fails closed (${JSON.stringify(bad)})`, { skip: !nativeProduct.blockers, timeout: 5000 }, async (t) => {
    let submissions = 0;
    const f = await fixture(t, { question: async () => bad,
      promptAsync: async () => { submissions++; return result(undefined, 204); },
    });
    await f.action("ses_target");
    const receipt = await f.wires.get("ses_target").call("message.deliver", inbound());
    assert.equal(receipt.disposition, "rejected"); assert.equal(submissions, 0);
  });
}

// Native halt order: an early idle, then cleanup sets time.completed, then the
// Runner's own idle. A normal turn end publishes only that final idle.
const halted = { id: "msg_halted", sessionID: "ses_target", role: "assistant", parentID: "msg_user", time: { created: 1 } };
const completed = { ...halted, time: { created: 1, completed: 2 }, finish: null };
const operator = { id: "msg_operator", sessionID: "ses_target", role: "user", time: { created: 3 } };
async function busyQueued(t, latest, before = []) {
  let busy = true;
  const counts = { snapshots: 0, submissions: 0 }, submitted = deferred();
  const f = await fixture(t, { status: async () => result(busy ? { ses_target: { type: "busy" } } : {}),
    messages: async (params) => {
      counts.snapshots++; assert.deepEqual(params, { sessionID: "ses_target", limit: 1 });
      return result([{ info: latest, parts: [] }]);
    }, promptAsync: async () => { counts.submissions++; submitted.resolve(); return result(undefined, 204); } });
  await f.action("ses_target");
  const update = async (info) => { f.events.emit("message.updated", { properties: { sessionID: info.sessionID, info } }); await nextTurn(); };
  for (const info of before) await update(info);
  assert.equal((await f.wires.get("ses_target").call("message.deliver", inbound())).disposition, "queued_for_next_turn");
  // Native idle event; native reports `native` to the status query it drives.
  const idle = async (native = "idle") => {
    busy = native !== "idle";
    f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "idle" } } });
    await nextTurn();
  };
  return { ...f, counts, idle, update, submitted: submitted.promise };
}

test("OpenCode busy-queued input needs completion and a later idle, not the early halt idle", { skip: !nativeProduct.terminalHandoff, timeout: 5000 }, async (t) => {
  const f = await busyQueued(t, halted);
  await f.idle(); // No assistant event yet: the snapshot binds the incomplete assistant.
  assert.deepEqual(f.counts, { snapshots: 1, submissions: 0 });
  await f.idle("busy"); await f.idle(); // A repeated busy check stays in this generation.
  assert.deepEqual(f.counts, { snapshots: 1, submissions: 0 });
  await f.update(completed); // Marks only; the old Runner is still installed.
  assert.equal(f.counts.submissions, 0);
  await f.idle(); // Runner.onIdle.
  assert.equal(f.counts.submissions, 1);
  await f.update(completed); await f.idle(); await f.owners.dispose();
  assert.deepEqual(f.counts, { snapshots: 1, submissions: 1 }); assert.deepEqual(f.failures, []);
});

test("OpenCode busy generation does not reuse a prior assistant witness", { skip: !nativeProduct.terminalHandoff, timeout: 5000 }, async (t) => {
  const prior = { ...completed, id: "msg_prior" };
  const current = { ...halted, id: "msg_current" };
  const f = await busyQueued(t, current, [prior]);
  await f.idle();
  assert.deepEqual(f.counts, { snapshots: 1, submissions: 0 });
  const currentCompleted = { ...current, time: { created: 3, completed: 4 } };
  await f.update(currentCompleted); await f.idle();
  assert.equal(f.counts.submissions, 1);
  await f.update(currentCompleted); await f.idle(); await f.owners.dispose();
  assert.deepEqual(f.counts, { snapshots: 1, submissions: 1 }); assert.deepEqual(f.failures, []);
});

for (const order of ["before", "after"]) {
  test(`OpenCode normal turn end hands off on its single idle (completion ${order} enqueue)`, { skip: !nativeProduct.terminalHandoff, timeout: 5000 }, async (t) => {
    const f = await busyQueued(t, halted, order === "before" ? [completed] : []);
    if (order === "after") await f.update(completed);
    assert.equal(f.counts.submissions, 0);
    await f.idle(); assert.equal(f.counts.submissions, 1);
    await f.update(completed); await f.idle(); await f.owners.dispose();
    assert.deepEqual(f.counts, { snapshots: order === "before" ? 1 : 0, submissions: 1 });
  });
}

test("OpenCode later user message does not make the early halt idle sufficient", { skip: !nativeProduct.terminalHandoff, timeout: 5000 }, async (t) => {
  const f = await busyQueued(t, operator, [halted]);
  await f.idle(); assert.equal(f.counts.submissions, 0);
  await f.update(completed); assert.equal(f.counts.submissions, 0);
  await f.idle(); await f.owners.dispose();
  assert.deepEqual(f.counts, { snapshots: 0, submissions: 1 });
});

test("OpenCode repeated busy check preserves the current assistant witness", { skip: !nativeProduct.terminalHandoff, timeout: 5000 }, async (t) => {
  const f = await busyQueued(t, operator);
  await f.update(halted);
  await f.idle("busy"); await f.idle();
  assert.deepEqual(f.counts, { snapshots: 0, submissions: 0 });
  await f.update(completed); await f.idle();
  assert.equal(f.counts.submissions, 1);
  await f.update(completed); await f.idle(); await f.owners.dispose();
  assert.deepEqual(f.counts, { snapshots: 0, submissions: 1 }); assert.deepEqual(f.failures, []);
});

test("OpenCode fallback snapshot rechecks an assistant observed while pending", { skip: !nativeProduct.terminalHandoff, timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred();
  let busy = true;
  const counts = { snapshots: 0, submissions: 0 };
  const f = await fixture(t, { status: async () => result(busy ? { ses_target: { type: "busy" } } : {}),
    messages: async (params) => {
      counts.snapshots++; assert.deepEqual(params, { sessionID: "ses_target", limit: 1 });
      entered.resolve(); await release.promise;
      return result([{ info: operator, parts: [] }]);
    }, promptAsync: async () => { counts.submissions++; return result(undefined, 204); } });
  await f.action("ses_target");
  assert.equal((await f.wires.get("ses_target").call("message.deliver", inbound())).disposition, "queued_for_next_turn");

  busy = false;
  f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "idle" } } });
  await entered.promise;
  f.events.emit("message.updated", { properties: { sessionID: halted.sessionID, info: halted } });
  release.resolve(); await nextTurn();
  assert.deepEqual(counts, { snapshots: 1, submissions: 0 });

  f.events.emit("message.updated", { properties: { sessionID: completed.sessionID, info: completed } });
  await nextTurn(); assert.equal(counts.submissions, 0);
  f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "idle" } } });
  await nextTurn(); assert.equal(counts.submissions, 1);
  f.events.emit("message.updated", { properties: { sessionID: completed.sessionID, info: completed } });
  f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "idle" } } });
  await nextTurn(); await f.owners.dispose();
  assert.deepEqual(counts, { snapshots: 1, submissions: 1 }); assert.deepEqual(f.failures, []);
});

// Documented limitation: without an observed assistant, a user message or an
// already completed assistant cannot be ordered against this idle.
for (const latest of [operator, completed]) {
  test(`OpenCode without an observed assistant hands off best effort (${latest.role} latest)`, { skip: !nativeProduct.terminalHandoff, timeout: 5000 }, async (t) => {
    const f = await busyQueued(t, latest);
    await f.idle(); await f.owners.dispose();
    assert.deepEqual(f.counts, { snapshots: 1, submissions: 1 });
  });
}

test("idle-time delivery hands off directly without a prior assistant snapshot", { timeout: 5000 }, async (t) => {
  let snapshots = 0, submissions = 0;
  const f = await fixture(t, { messages: async () => { snapshots++; return result([{ info: halted, parts: [] }]); },
    promptAsync: async () => { submissions++; return result(undefined, 204); } });
  await f.action("ses_target");
  assert.equal((await f.wires.get("ses_target").call("message.deliver", inbound())).disposition, "written");
  assert.equal(submissions, 1); assert.equal(snapshots, 0);
});

test("Kilo busy-queued input still hands off on native idle without a terminal witness", { skip: nativeProduct.terminalHandoff, timeout: 5000 }, async (t) => {
  const f = await busyQueued(t, halted);
  await f.idle(); await f.submitted; await f.owners.dispose();
  assert.deepEqual(f.counts, { snapshots: 0, submissions: 1 });
});

const nativeBind = (id = "ses_target", messageID = "msg_active", created = 10) => ({ operation: "bind", sessionID: id, messageID, created });
function modelStep(f, parentID = "msg_active", summary = false) {
  f.events.emit("message.updated", { properties: { info: { id: "msg_model", role: "assistant", sessionID: "ses_target", parentID, summary } } });
  f.events.emit("message.part.updated", { properties: { part: { id: "prt_start", sessionID: "ses_target", messageID: "msg_model", type: "step-start" } } });
}
test("unobserved hook diagnostic preserves tools and later idle wake", { timeout: 5000 }, async (t) => {
  for (const brokenReport of [false, true]) await t.test(`report failure=${brokenReport}`, async (t) => {
    let status = "busy", prompts = 0, received;
    const submitted = deferred();
    const f = await fixture(t, { status: async () => result(status === "busy" ? { ses_target: { type: "busy" } } : {}),
      promptAsync: async (params) => { prompts++; received = params; submitted.resolve(); return result(undefined, 204); },
      report: (error) => { if (brokenReport && error.message.includes("did not observe")) throw new Error("diagnostic report failed"); },
    });
    const signal = new AbortController().signal;
    await f.action("ses_target"); await f.owners.nativeInput(nativeBind(), signal);
    await f.wires.get("ses_target").call("message.deliver", inbound("unobserved_hook"));
    modelStep(f);
    assert.equal(f.failures.length, 1); assert.match(f.failures[0].message, /did not observe the expected input hook/);
    await f.action("ses_target"); assert.equal(f.sockets.size, 1); assert.equal(prompts, 0);
    f.events.emit("message.updated", { properties: { info: { id: "msg_model", role: "assistant", sessionID: "ses_target", parentID: "msg_active", time: { completed: 20 } } } });
    status = "idle";
    f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "idle" } } });
    await submitted.promise;
    assert.match(received.parts[0].text, /unobserved_hook/);
    f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "idle" } } });
    await f.owners.dispose(); assert.equal(prompts, 1);
  });
});
test("next valid hook drains retained input in the same task after an unobserved step", { timeout: 5000 }, async (t) => {
  const patched = []; let status = "busy", prompts = 0;
  const f = await fixture(t, { status: async () => result(status === "busy" ? { ses_target: { type: "busy" } } : {}),
    part: async (params) => { patched.push(params.part); return result(params.part); },
    promptAsync: async () => { prompts++; return result(undefined, 204); },
  });
  const signal = new AbortController().signal;
  await f.action("ses_target"); const { token } = await f.owners.nativeInput(nativeBind(), signal);
  await f.wires.get("ses_target").call("message.deliver", inbound("next_step_owned"));
  modelStep(f);
  assert.equal(f.failures.length, 1); assert.equal(patched.length, 0); assert.equal(prompts, 0);
  const step = { ...nativeBind(), operation: "step", token, after: "prt_authored" };
  const next = await f.owners.nativeInput(step, signal);
  assert.equal(patched.length, 1); assert.match(next.parts[0].text, /next_step_owned/);
  assert.equal(next.parts[0].messageID, "msg_active"); assert.equal(status, "busy");
  assert.deepEqual(await f.owners.nativeInput(step, signal), { parts: [] });
  modelStep(f); assert.equal(f.failures.length, 1);
  status = "idle"; f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "idle" } } });
  await f.owners.dispose(); assert.equal(prompts, 0); assert.equal(patched.length, 1);
});
test("an empty-FIFO unobserved-step diagnostic does not infer permanent delivery failure", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); await f.action("ses_target"); await f.owners.nativeInput(nativeBind(), new AbortController().signal);
  modelStep(f);
  assert.equal(f.failures.length, 1); assert.match(f.failures[0].message, /did not observe.*this model step/);
  assert.doesNotMatch(f.failures[0].message, /unavailable|could not deliver messages|native input hook did not run/);
  await f.action("ses_target"); assert.equal(f.sockets.size, 1);
});
test("empty hook before the first busy event proves the model-step integration", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); await f.action("ses_target"); const signal = new AbortController().signal;
  const { token } = await f.owners.nativeInput(nativeBind(), signal);
  assert.deepEqual(await f.owners.nativeInput({ ...nativeBind(), operation: "step", token, after: "prt_authored" }, signal), { parts: [] });
  f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "busy" } } });
  modelStep(f); await f.action("ses_target"); assert.deepEqual(f.failures, []);
});
test("summary, static, subtask and stale-parent evidence does not falsely retire integration", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); await f.action("ses_target"); await f.owners.nativeInput(nativeBind(), new AbortController().signal);
  modelStep(f, "msg_active", true); // summaries are not the ordinary model witness
  modelStep(f, "msg_old_parent");
  for (const finish of ["stop", "tool-calls"]) f.events.emit("message.updated", { properties: { info: { id: "msg_static", sessionID: "ses_target", role: "assistant", parentID: "msg_active", finish, time: { completed: 20 } } } });
  await f.action("ses_target"); assert.deepEqual(f.failures, []);
});
test("an idle then busy crossing never revives a held pre-halt step", { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred(); const patched = [];
  const f = await fixture(t, { status: async () => result({ ses_target: { type: "busy" } }), part: async (params) => {
    patched.push(params.part); if (patched.length === 1) { entered.resolve(); await release.promise; } return result(params.part);
  } });
  await f.action("ses_target"); const signal = new AbortController().signal;
  const { token } = await f.owners.nativeInput(nativeBind(), signal);
  const step = { ...nativeBind(), operation: "step", token, after: "prt_authored" };
  await f.wires.get("ses_target").call("message.deliver", inbound("attempted_first"));
  const first = f.owners.nativeInput(step, signal); await entered.promise;
  await f.wires.get("ses_target").call("message.deliver", inbound("still_unsent_second"));
  let settled = false; const old = f.owners.nativeInput(step, signal).then((value) => { settled = true; return value; });
  await nextTurn(); assert.equal(settled, false);
  f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "idle" } } });
  f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "busy" } } });
  release.resolve(); await first; assert.deepEqual(await old, { parts: [] }); assert.equal(patched.length, 1);
  const next = await f.owners.nativeInput(step, signal); assert.equal(patched.length, 2); assert.equal(next.parts.length, 1); assert.match(next.parts[0].text, /still_unsent_second/);
});
test("owned hook inserts a durable additive part during busy work on the exact session", { timeout: 5000 }, async (t) => {
  const patched = [];
  const f = await fixture(t, { status: async () => result({ ses_target: { type: "busy" } }),
    part: async (params, config) => {
      assert.equal(config.signal.aborted, false); assert.equal(params.sessionID, "ses_target");
      assert.equal(params.messageID, "msg_active"); assert.equal(params.partID, params.part.id);
      patched.push(structuredClone(params.part)); return result(params.part);
    },
    question: async () => result([{ sessionID: "ses_target" }]), permission: async () => result([{ sessionID: "ses_target" }]),
    liveQuestion: () => [{ sessionID: "ses_target" }], livePermission: () => [{ sessionID: "ses_target" }],
  });
  await f.action("ses_target");
  const signal = new AbortController().signal;
  const hooks = inputHooks((request, cancel) => f.owners.nativeInput(request, cancel), signal);
  const current = { info: { role: "user", sessionID: "ses_target", id: "msg_active", time: { created: 10 } },
    parts: [{ id: "prt_authored", sessionID: "ses_target", messageID: "msg_active", type: "text", text: "authored exact bytes" }] };
  await hooks["chat.message"]({ sessionID: "ses_target" }, { message: current.info });
  await f.wires.get("ses_target").call("message.deliver", inbound("busy_step"));
  await hooks["experimental.chat.messages.transform"]({}, { messages: [current] });
  assert.equal(patched.length, 1); assert.deepEqual(current.parts.slice(1), patched); assert.match(current.parts[1].text, /busy_step/);
  assert.equal(current.parts[0].text, "authored exact bytes");
  await hooks["experimental.chat.messages.transform"]({}, { messages: [current] });
  assert.equal(patched.length, 1); assert.equal(current.parts.length, 2);
});

test("late public adoption lets a child hook claim only its exact active inbox", { timeout: 5000 }, async (t) => {
  const patched = [], requests = [];
  const f = await fixture(t, { status: async () => result({ ses_parent: { type: "busy" }, ses_child: { type: "busy" } }),
    part: async (params) => { patched.push(params.part); return result(params.part); },
  });
  await f.action("ses_parent");
  const hooks = inputHooks((request, signal) => { requests.push(request); return f.owners.nativeInput(request, signal); }, new AbortController().signal);
  const current = (sessionID, id) => ({ info: { role: "user", sessionID, id, time: { created: 10 } },
    parts: [{ id: "prt_authored", sessionID, messageID: id, type: "text", text: `authored ${sessionID}` }] });
  const child = current("ses_child", "msg_child"), unknown = current("ses_unknown", "msg_unknown");
  await hooks["chat.message"]({ sessionID: "ses_child" }, { message: child.info });
  await hooks["experimental.chat.messages.transform"]({}, { messages: [child] });
  await hooks["experimental.chat.messages.transform"]({}, { messages: [unknown] });
  assert.equal(f.wires.size, 1); assert.equal(patched.length, 0);
  await f.action("ses_child");
  await f.wires.get("ses_parent").call("message.deliver", inbound("parent_still_owned"));
  await f.wires.get("ses_child").call("message.deliver", inbound("child_busy_adopted"));
  await hooks["experimental.chat.messages.transform"]({}, { messages: [child] });
  assert.equal(patched.length, 1); assert.equal(patched[0].sessionID, "ses_child"); assert.match(child.parts[1].text, /child_busy_adopted/);
  assert.doesNotMatch(child.parts[1].text, /parent_still_owned/); assert.equal(child.parts[0].text, "authored ses_child");
  f.events.emit("message.updated", { properties: { info: { id: "msg_child_assistant", role: "assistant", sessionID: "ses_child", parentID: "msg_child" } } });
  f.events.emit("message.part.updated", { properties: { part: { sessionID: "ses_child", messageID: "msg_child_assistant", type: "step-start" } } });
  assert.deepEqual(f.failures, []); // Late adoption is a legitimate integration.
  const binds = requests.filter((request) => request.operation === "bind").length;
  await f.owners.nativeInput(nativeBind("ses_child", "msg_new_child", 11), new AbortController().signal);
  await f.wires.get("ses_child").call("message.deliver", inbound("stale_child_unsent"));
  await hooks["experimental.chat.messages.transform"]({}, { messages: [child] });
  assert.equal(patched.length, 1); assert.equal(requests.filter((request) => request.operation === "bind").length, binds, "an accepted stale token is never automatically rebound");
  const parent = current("ses_parent", "msg_parent");
  await hooks["chat.message"]({ sessionID: "ses_parent" }, { message: parent.info });
  await hooks["experimental.chat.messages.transform"]({}, { messages: [parent] });
  assert.equal(patched.length, 2); assert.match(parent.parts[1].text, /parent_still_owned/); assert.doesNotMatch(parent.parts[1].text, /child_busy_adopted/);
});

test("known halt before step invocation keeps never-attempted input owned", { timeout: 5000 }, async (t) => {
  let patches = 0, hold = false; const release = deferred();
  const f = await fixture(t, { status: async () => { if (hold) await release.promise; return result({ ses_target: { type: "busy" } }); }, part: async (params) => { patches++; return result(params.part); } });
  await f.action("ses_target"); const signal = new AbortController().signal;
  const { token } = await f.owners.nativeInput(nativeBind(), signal);
  await f.wires.get("ses_target").call("message.deliver", inbound("halted_before_step"));
  hold = true;
  f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "idle" } } });
  assert.deepEqual(await f.owners.nativeInput({ ...nativeBind(), operation: "step", token, after: "prt_authored" }, signal), { parts: [] });
  assert.equal(patches, 0);
  // The same FIFO still owns the input; a later legitimate active boundary
  // can claim it, with no restore or new admission.
  f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "busy" } } });
  hold = false; release.resolve();
  const next = await f.owners.nativeInput({ ...nativeBind(), operation: "step", token, after: "prt_authored" }, signal);
  assert.equal(next.parts.length, 1); assert.equal(patches, 1);
});

test("foreign, retired and stale-generation hook bindings cannot touch the owned FIFO", { timeout: 5000 }, async (t) => {
  let patches = 0;
  const f = await fixture(t, { status: async () => result({ ses_target: { type: "busy" } }),
    part: async (params) => { patches++; return result(params.part); },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await f.owners.nativeInput(nativeBind("ses_foreign"), signal), { token: null });
  assert.equal(f.wires.size, 0);
  await f.action("ses_target");
  const old = await f.owners.nativeInput(nativeBind(), signal);
  await f.wires.get("ses_target").call("message.deliver", inbound("generation"));
  const newer = await f.owners.nativeInput(nativeBind("ses_target", "msg_new", 11), signal);
  const step = { ...nativeBind(), operation: "step", after: "prt_authored", token: old.token };
  assert.deepEqual(await f.owners.nativeInput(step, signal), { parts: [] });
  assert.deepEqual(await f.owners.nativeInput({ ...step, token: newer.token }, signal), { parts: [] });
  await assert.rejects(f.owners.nativeInput({ ...nativeBind(), operation: "unknown" }, signal), /invalid/);
  assert.equal(patches, 0);
  await f.owners.nativeInput({ ...nativeBind("ses_target", "msg_new", 11), operation: "step", after: "prt_authored", token: newer.token }, signal);
  assert.equal(patches, 1);
  f.events.emit("session.deleted", { properties: { info: { id: "ses_target" } } });
  assert.deepEqual(await f.owners.nativeInput({ ...step, token: newer.token }, signal), { parts: [] });
});

test("End disposal cancels and joins an in-flight native step without restoring its batch", { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred(); let cancel, patches = 0;
  const f = await fixture(t, { status: async () => result({ ses_target: { type: "busy" } }), part: async (_params, config) => {
    cancel = config.signal; patches++; entered.resolve(); await release.promise; throw cancel.reason;
  } });
  await f.action("ses_target"); const signal = new AbortController().signal;
  const { token } = await f.owners.nativeInput(nativeBind(), signal);
  await f.wires.get("ses_target").call("message.deliver", inbound("close_step"));
  const failed = assert.rejects(f.owners.nativeInput({ ...nativeBind(), operation: "step", after: "prt_authored", token }, signal), /disposed/);
  await entered.promise;
  let joined = false; const disposing = f.owners.dispose().then(() => { joined = true; });
  assert.equal(cancel.aborted, true); assert.equal(joined, false);
  release.resolve(); await failed; await disposing; assert.equal(patches, 1);
});

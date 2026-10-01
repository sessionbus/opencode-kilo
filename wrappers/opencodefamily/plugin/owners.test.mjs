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
  }, part: { update: (params, config) => options.partUpdate ? options.partUpdate(params, config) : result(params.part) },
    permission: { list: (params, config) => options.permission ? options.permission(params, config) : result([]) },
    question: { list: (params, config) => options.question ? options.question(params, config) : result([]) },
  }, state: { session: {
    permission: (id) => options.livePermission?.(id) || [], question: (id) => options.liveQuestion?.(id) || [],
  } } };
  const owners = new NativeOwners(api, { socket, groups: ["group"], name: options.name || "" }, { report: (error) => failures.push(error), peer: options.peer });
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

test("busy handoff appends queued input to the current prompt once; idle then has nothing to submit", { timeout: 5000 }, async (t) => {
  const patches = [];
  let busy = true, submissions = 0;
  const f = await fixture(t, { status: async () => result(busy ? { ses_target: { type: "busy" } } : {}),
    partUpdate: async (params, config) => {
      assert.equal(config.throwOnError, true); assert.equal(config.redirect, "error");
      patches.push(params); return result(params.part);
    },
    promptAsync: async () => { submissions++; return result(undefined, 204); } });
  await f.action("ses_target");
  assert.equal((await f.wires.get("ses_target").call("message.deliver", inbound("first"))).disposition, "queued_for_next_turn");
  assert.equal((await f.wires.get("ses_target").call("message.deliver", inbound("second"))).disposition, "queued_for_next_turn");
  const after = "prt_000000000001ABCDEFGHIJKLMN";
  const reply = await f.owners.nativeInput({ sessionID: "ses_target", messageID: "msg_prompt", after }, new AbortController().signal);
  assert.equal(patches.length, 1); assert.equal(reply.parts.length, 1);
  const part = reply.parts[0];
  assert.deepEqual(patches[0].part, part);
  assert.equal(patches[0].partID, part.id); assert.equal(patches[0].messageID, "msg_prompt"); assert.equal(patches[0].sessionID, "ses_target");
  assert.equal(part.type, "text"); assert.ok(part.id > after);
  assert.match(part.text, /messageId":"first".*messageId":"second"/su);
  assert.deepEqual((await f.owners.nativeInput({ sessionID: "ses_target", messageID: "msg_prompt", after: part.id }, new AbortController().signal)).parts, []);
  busy = false;
  f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "idle" } } });
  await nextTurn(); await f.owners.dispose();
  assert.equal(submissions, 0); assert.equal(patches.length, 1);
});

test("busy handoff: unowned session or unknown floor hands off nothing; an attempted write is never retried", { timeout: 5000 }, async (t) => {
  let busy = true, submissions = 0, patches = 0;
  const f = await fixture(t, { status: async () => result(busy ? { ses_target: { type: "busy" } } : {}),
    partUpdate: async () => { patches++; throw new Error("native write lost"); },
    promptAsync: async () => { submissions++; return result(undefined, 204); } });
  const signal = new AbortController().signal;
  assert.deepEqual(await f.owners.nativeInput({ sessionID: "ses_nobody", messageID: "msg_prompt", after: "prt_000000000001ABCDEFGHIJKLMN" }, signal), { parts: [] });
  await f.action("ses_target");
  assert.equal((await f.wires.get("ses_target").call("message.deliver", inbound("kept"))).disposition, "queued_for_next_turn");
  assert.deepEqual(await f.owners.nativeInput({ sessionID: "ses_target", messageID: "msg_prompt", after: "not-a-native-part" }, signal), { parts: [] });
  assert.equal(patches, 0);
  await assert.rejects(f.owners.nativeInput({ sessionID: "ses_target", messageID: "msg_prompt", after: "prt_000000000001ABCDEFGHIJKLMN" }, signal), /native write lost/);
  assert.equal(patches, 1);
  busy = false;
  f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "idle" } } });
  await nextTurn(); await f.owners.dispose();
  assert.equal(submissions, 0);
});

test("busy input not handed off at a step is still delivered by the existing idle wake", { timeout: 5000 }, async (t) => {
  let busy = true, submissions = 0;
  const submitted = deferred();
  const f = await fixture(t, { status: async () => result(busy ? { ses_target: { type: "busy" } } : {}),
    messages: async () => result([{ info: { id: "msg_done", role: "assistant", time: { completed: 1 } } }]),
    promptAsync: async (params) => { submissions++; assert.match(params.parts[0].text, /missed_step/); submitted.resolve(); return result(undefined, 204); } });
  await f.action("ses_target");
  assert.equal((await f.wires.get("ses_target").call("message.deliver", inbound("missed_step"))).disposition, "queued_for_next_turn");
  busy = false;
  f.events.emit("session.status", { properties: { sessionID: "ses_target", status: { type: "idle" } } });
  await submitted.promise; await f.owners.dispose();
  assert.equal(submissions, 1);
});

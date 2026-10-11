// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { Peer } from "@sessionbus/kit";
import { createServer } from "./server.mjs";
import { createTui } from "./tui.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const message = { message_id: "m1", body: "hello", from: { session_id: "sender@host", name: "sender", product: "test", groups: [] } };

// Fake native server ctx: records registrations and prompts.
function serverContext(t, prompt = async () => ({})) {
  const ctx = { location: { directory: "/work" }, prompts: [], updates: [] };
  // Native hands each handler its RPC context: the call's signal and the declared-error factory.
  ctx.rpc = { register: async (_contract, handlers) => {
    ctx.handlers = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, (input, signal = new AbortController().signal) =>
      handler(input, { signal, error: (type, message, data) => ({ rpcError: { type, message, data } }) })]));
    return { dispose: async () => {} };
  } };
  ctx.session = {
    get: async ({ sessionID }) => ({ id: sessionID, title: "native title" }),
    prompt: async (input) => { ctx.prompts.push(input); return prompt(input); },
    update: async (input) => { ctx.updates.push(input); },
    hook: async (name, callback) => { ctx.hooks = { ...ctx.hooks, [name]: callback }; return { dispose: async () => {} }; },
  };
  ctx.tool = { transform: async (callback) => { callback({ add: (tool) => { ctx.tool.added = tool; } }); return { dispose: async () => {} }; } };
  // Native event stream the test feeds with ctx.publish(event).
  const pending = [];
  let wake;
  ctx.publish = (event) => { pending.push(event); wake?.(); };
  ctx.event = { subscribe: ({ signal }) => ({ async *[Symbol.asyncIterator]() {
    while (!signal.aborted) {
      if (!pending.length) await new Promise((resolve) => { wake = resolve; signal.addEventListener("abort", resolve, { once: true }); });
      while (pending.length) yield pending.shift();
    }
  } }) };
  return ctx;
}
function fakePeers() {
  const peers = [];
  const peer = (identity, deliver, env) => {
    const controller = new AbortController();
    const value = { identity, deliver, env, disposed: false, actions: [], signal: controller.signal };
    value.action = async (action, args) => { value.actions.push([action, args]); return { ok: true }; };
    value.dispose = async () => { value.disposed = true; controller.abort(); };
    value.renames = [];
    value.rehello = async (name, info) => { value.renames.push([name, info]); };
    // Admitted at once unless a test holds or refuses it.
    value.ready = (signal) => value.admission ? value.admission(signal) : Promise.resolve();
    peers.push(value);
    return value;
  };
  return { peers, peer };
}

test("server: activate is idempotent, names the peer and delivers as one native steer prompt", async (t) => {
  const { peers, peer } = fakePeers();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"], name: "worker" });
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  assert.equal(peers.length, 1);
  assert.deepEqual(peers[0].identity, { product: "opencode-peer", session_id: "ses_a", groups: ["team"], info: { cwd: "/work" }, name: "worker" });
  assert.deepEqual(peers[0].env, { SESSIONBUS_SOCKET: "/bus.sock" });
  assert.deepEqual(await peers[0].deliver(undefined, message), { disposition: "injected" });
  assert.equal(ctx.prompts.length, 1);
  assert.equal(ctx.prompts[0].sessionID, "ses_a"); assert.equal(ctx.prompts[0].delivery, "steer");
  assert.match(ctx.prompts[0].text, /^<cross-session-message from="sender" from-session="sender@host">[\s\S]*hello/u);
  await ctx.handlers.activate({ sessionID: "ses_b", socket: "/bus.sock", groups: ["team"] });
  assert.equal(peers[1].identity.name, "native title");
  await cleanup();
  assert.ok(peers.every((value) => value.disposed));
});

test("server: concurrent activations of one session create one Peer", async (t) => {
  const { peers, peer } = fakePeers();
  const ctx = serverContext(t);
  const held = [], granting = [];
  ctx.session.get = ({ sessionID }) => new Promise((resolve) => held.push(() => resolve({ id: sessionID, title: "native title" })));
  // The grant is the last await before the Peer is created.
  ctx.session.update = (input) => new Promise((resolve) => granting.push(() => { ctx.updates.push(input); resolve(); }));
  const cleanup = await createServer({ peer })(ctx);
  const first = ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  const second = ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  for (let i = 0; i < 5 && held.length < 2; i++) await flush();
  assert.equal(held.length, 2);
  for (const release of held) release();
  for (let i = 0; i < 5 && granting.length < 2; i++) await flush();
  assert.equal(granting.length, 2);
  for (const release of granting) release();
  await Promise.all([first, second]);
  assert.equal(peers.length, 1);
  await cleanup();
  assert.deepEqual(peers.map((value) => value.disposed), [true]);
});

// Through the pinned kit's own message.deliver mapping: a failed native prompt
// may already be admitted, so the bus gets an uncertain error, not a refusal.
test("server: activation succeeds only once the bus admits the session; otherwise it says why and keeps the Peer", async (t) => {
  const { peers, peer } = fakePeers();
  const ctx = serverContext(t);
  let admit, refuse;
  const held = (value) => { value.admission = (signal) => new Promise((resolve, reject) => {
    admit = resolve; refuse = reject; signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }); };
  const cleanup = await createServer({ peer: (...args) => { const value = peer(...args); held(value); return value; }, admissionWait: 30 })(ctx);
  // Admitted within the wait: activation succeeds.
  const first = ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  await flush(); admit(); await first;
  // Unreachable bus: activation returns the declared transient error; the Peer stays and keeps trying.
  assert.deepEqual(await ctx.handlers.activate({ sessionID: "ses_b", socket: "/absent.sock", groups: ["team"] }),
    { rpcError: { type: "sessionbus.not_admitted", message: "the bus has not admitted this session yet; still connecting", data: {} } });
  assert.equal(peers.length, 2); assert.equal(peers[1].disposed, false);
  // A cancelled RPC ends only its wait; the Peer stays.
  const cancel = new AbortController();
  const cancelled = ctx.handlers.activate({ sessionID: "ses_b", socket: "/absent.sock", groups: ["team"] }, cancel.signal);
  await flush(); cancel.abort(new Error("rpc cancelled"));
  await assert.rejects(cancelled, /rpc cancelled/u);
  assert.equal(peers.length, 2); assert.equal(peers[1].disposed, false);
  // A later activation of the same session waits again on the same Peer.
  const again = ctx.handlers.activate({ sessionID: "ses_b", socket: "/absent.sock", groups: ["team"] });
  await flush(); admit(); await again;
  assert.equal(peers.length, 2);
  // A permanent refusal is reported as itself.
  const third = ctx.handlers.activate({ sessionID: "ses_c", socket: "/bus.sock", groups: ["team"] });
  await flush(); refuse(new Error("invalid_hello")); await assert.rejects(third, /invalid_hello/u);
  // A sub-agent shown by a managed TUI attaches nothing and waits for nothing.
  ctx.session.get = async ({ sessionID }) => ({ id: sessionID, title: "child", parentID: "ses_a" });
  await ctx.handlers.activate({ sessionID: "ses_child", socket: "/bus.sock", groups: ["team"] });
  assert.equal(peers.length, 3);
  await cleanup();
});

test("server: a failed native prompt is an uncertain outcome at the bus, never a refusal or a retry", async (t) => {
  const { peers, peer } = fakePeers();
  const ctx = serverContext(t, async () => { throw new Error("instance closing"); });
  const cleanup = await createServer({ peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  const kit = new Peer({ product: "opencode-peer", session_id: "ses_a", groups: ["team"] }, peers[0].deliver, { SESSIONBUS_SOCKET: "/nonexistent/bus.sock" }, { connect: () => { throw new Error("offline"); }, schedule: () => {} });
  const replies = [];
  const connection = { result: async (_request, value) => { replies.push(["result", value]); }, error: async (_request, code, data) => { replies.push(["error", code, data]); }, close() {} };
  kit.connection = connection; kit.admitted = kit.identity; kit.identityController = new AbortController();
  kit._handle({ method: "message.deliver", params: message }, connection);
  for (let i = 0; i < 5 && !replies.length; i++) await flush();
  assert.deepEqual(replies, [["error", -32603, "instance closing"]]);
  assert.equal(ctx.prompts.length, 1);
  kit.shutdown();
  await cleanup();
});

test("server: native sub-agents speak as the activated session they descend from, never as peers of their own", async (t) => {
  const { peers, peer } = fakePeers();
  const ctx = serverContext(t);
  const parents = { ses_child: "ses_a", ses_grandchild: "ses_child", ses_stray: "ses_other", ses_loop1: "ses_loop2", ses_loop2: "ses_loop1" };
  let lookups = 0;
  ctx.session.get = async ({ sessionID }) => { lookups++; return { id: sessionID, title: "native title", parentID: parents[sessionID] }; };
  const cleanup = await createServer({ peer })(ctx);
  // Nothing attached: no native reads, the tool is hidden.
  const early = { sessionID: "ses_child", tools: { sessionbus: {} } };
  await ctx.hooks.context(early);
  assert.equal(lookups, 0); assert.deepEqual(Object.keys(early.tools), []);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"], name: "worker" });
  lookups = 0;
  // Native creation of a child attaches nothing.
  ctx.publish({ type: "session.created", data: { sessionID: "ses_child", parentID: "ses_a" } });
  await flush(); await flush();
  assert.equal(peers.length, 1);
  // Children and grandchildren of the activated session see the tool; others do not.
  const visible = {};
  for (const sessionID of ["ses_a", "ses_child", "ses_grandchild", "ses_stray", "ses_unrelated", "ses_loop1"]) {
    const request = { sessionID, tools: { sessionbus: {} } };
    await ctx.hooks.context(request);
    visible[sessionID] = Object.keys(request.tools).length === 1;
  }
  assert.deepEqual(visible, { ses_a: true, ses_child: true, ses_grandchild: true, ses_stray: false, ses_unrelated: false, ses_loop1: false });
  // A sub-agent's call goes through the activated session's Peer: its source and self_info.
  await ctx.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_grandchild" });
  assert.deepEqual(peers[0].actions, [["list", {}]]);
  await assert.rejects(ctx.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_stray" }), /not active/u);
  // A managed TUI showing a sub-agent attaches and grants nothing (owner, 2026-10-01).
  await ctx.handlers.activate({ sessionID: "ses_child", socket: "/bus.sock", groups: ["team"] });
  assert.equal(peers.length, 1);
  assert.deepEqual(ctx.updates.map((update) => update.sessionID), ["ses_a"]);
  // A failing native read never throws into native; the tool is hidden.
  ctx.session.get = async () => { throw new Error("lookup failed"); };
  const failing = { sessionID: "ses_other_child", tools: { sessionbus: {} } };
  await ctx.hooks.context(failing);
  assert.deepEqual(Object.keys(failing.tools), []);
  await cleanup();
  assert.ok(peers.every((value) => value.disposed));
});

test("server: an activated session keeps the Sessionbus tool through one last allow rule", async (t) => {
  const { peers, peer } = fakePeers();
  const ctx = serverContext(t);
  const grant = { action: "sessionbus", resource: "*", effect: "allow" };
  const deny = { action: "sessionbus", resource: "*", effect: "deny" };
  const ask = { action: "shell", resource: "*", effect: "ask" };
  const rules = { ses_deny: [deny, ask], ses_granted: [ask, grant], ses_buried: [grant, deny] };
  ctx.session.get = async ({ sessionID }) => ({ id: sessionID, title: "native title", permissions: rules[sessionID] });
  const cleanup = await createServer({ peer })(ctx);
  for (const sessionID of ["ses_deny", "ses_granted", "ses_buried", "ses_none"]) await ctx.handlers.activate({ sessionID, socket: "/bus.sock", groups: ["team"] });
  assert.deepEqual(ctx.updates, [
    { sessionID: "ses_deny", permissions: [deny, ask, grant] },
    { sessionID: "ses_buried", permissions: [grant, deny, grant] },
    { sessionID: "ses_none", permissions: [grant] },
  ]);
  assert.equal(peers.length, 4);
  // An activation that cannot be granted is not attached: no Peer without its
  // tool, and an existing Peer is left as it is.
  ctx.session.update = async () => { throw new Error("update failed"); };
  await assert.rejects(ctx.handlers.activate({ sessionID: "ses_failed", socket: "/bus.sock", groups: ["team"] }), /update failed/u);
  rules.ses_deny = [deny, ask];
  await assert.rejects(ctx.handlers.activate({ sessionID: "ses_deny", socket: "/bus.sock", groups: ["team"] }), /update failed/u);
  assert.equal(peers.length, 4); assert.ok(peers.every((value) => !value.disposed));
  await cleanup();
});

test("server: a native rename says hello again under the new title; invalid titles keep the old name", async (t) => {
  const { peers, peer } = fakePeers();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  ctx.publish({ type: "session.renamed", data: { sessionID: "ses_other", title: "elsewhere" } });
  ctx.publish({ type: "session.renamed", data: { sessionID: "ses_a", title: "renamed worker" } });
  ctx.publish({ type: "session.renamed", data: { sessionID: "ses_a", title: "x".repeat(300) } });
  // Space separators other than the ASCII space: the daemon refuses them.
  ctx.publish({ type: "session.renamed", data: { sessionID: "ses_a", title: "x\u3000y" } });
  ctx.publish({ type: "session.renamed", data: { sessionID: "ses_a", title: "a\u00a0b" } });
  ctx.publish({ type: "session.renamed", data: { sessionID: "ses_a", title: "名前 🙂 ünï" } });
  for (let i = 0; i < 10 && peers[0].renames.length < 2; i++) await flush();
  await flush();
  assert.deepEqual(peers[0].renames, [["renamed worker", { cwd: "/work" }], ["名前 🙂 ünï", { cwd: "/work" }]]);
  // At activation such a name or title leaves the peer unnamed rather than refused.
  await ctx.handlers.activate({ sessionID: "ses_space", socket: "/bus.sock", groups: ["team"], name: "x\u3000y" });
  await ctx.handlers.activate({ sessionID: "ses_unicode", socket: "/bus.sock", groups: ["team"], name: "名前" });
  assert.deepEqual(peers.slice(1).map((value) => [value.identity.session_id, value.identity.name]), [["ses_space", undefined], ["ses_unicode", "名前"]]);
  await cleanup();
});

test("server: a natively deleted session leaves the bus; others stay", async (t) => {
  const { peers, peer } = fakePeers();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  await ctx.handlers.activate({ sessionID: "ses_b", socket: "/bus.sock", groups: ["team"] });
  ctx.publish({ type: "session.deleted", data: { sessionID: "ses_other" } });
  ctx.publish({ type: "session.deleted", data: { sessionID: "ses_a" } });
  for (let i = 0; i < 5 && !peers[0].disposed; i++) await flush();
  assert.equal(peers[0].disposed, true); assert.equal(peers[1].disposed, false);
  await assert.rejects(ctx.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_a" }), /not active/u);
  await cleanup();
  assert.equal(peers[1].disposed, true);
});

test("server: the tool serves only activated sessions, which alone see it", async (t) => {
  const { peers, peer } = fakePeers();
  const ctx = serverContext(t);
  await createServer({ peer })(ctx);
  const tool = ctx.tool.added;
  assert.equal(tool.name, "sessionbus"); assert.equal(tool.options.codemode, false);
  await assert.rejects(tool.execute({ action: "list", arguments: {} }, { sessionID: "ses_a" }), /not active/u);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  assert.deepEqual(await tool.execute({ action: "list", arguments: {} }, { sessionID: "ses_a" }), { content: '{"ok":true}' });
  assert.deepEqual(peers[0].actions, [["list", {}]]);
  await assert.rejects(tool.execute({ action: "list" }, { sessionID: "ses_a" }), /action and arguments/u);
  const shown = { sessionID: "ses_a", tools: { sessionbus: {}, bash: {} } }, hidden = { sessionID: "ses_x", tools: { sessionbus: {}, bash: {} } };
  await ctx.hooks.context(shown); await ctx.hooks.context(hidden);
  assert.deepEqual(Object.keys(shown.tools), ["sessionbus", "bash"]);
  assert.deepEqual(Object.keys(hidden.tools), ["bash"]);
});

// Fake native TUI context with a controllable route and event stream.
// Fake lane forwarders: each records its tool calls; end() closes its connection.
function fakeForwarders() {
  const forwards = [];
  const forwarder = (socket) => {
    let end;
    const value = { socket, actions: [], disposed: false, closed: new Promise((resolve) => { end = resolve; }) };
    value.end = end;
    value.ready = async () => {};
    value.action = async (action, args, context) => { value.actions.push([action, args, context.sessionID, context.messageID]); return { via: socket }; };
    value.dispose = async () => { value.disposed = true; end(); };
    forwards.push(value);
    return value;
  };
  return { forwards, forwarder };
}

test("server: a lane binds its session's tool to the worker's endpoint, idempotently, with no Peer", async (t) => {
  const { peers, peer } = fakePeers();
  const { forwards, forwarder } = fakeForwarders();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer, forwarder })(ctx);
  assert.deepEqual(await ctx.handlers.lane({ sessionID: "ses_l", socket: "/lane.sock" }), {});
  assert.deepEqual(await ctx.handlers.lane({ sessionID: "ses_l", socket: "/lane.sock" }), {});
  assert.equal(forwards.length, 1); assert.equal(peers.length, 0);
  assert.deepEqual(await ctx.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_l", messageID: "msg_1" }), { content: '{"via":"/lane.sock"}' });
  assert.deepEqual(forwards[0].actions, [["list", {}, "ses_l", "msg_1"]]);
  const shown = { sessionID: "ses_l", tools: { sessionbus: {} } };
  await ctx.hooks.context(shown);
  assert.deepEqual(Object.keys(shown.tools), ["sessionbus"]);
  // A lane's name is the worker's: a native rename says no hello.
  ctx.publish({ type: "session.renamed", data: { sessionID: "ses_l", title: "renamed" } });
  await flush(); await flush();
  await cleanup();
  assert.equal(forwards[0].disposed, true);
});

test("server: one holder per session: a TUI cannot activate a lane's session, nor a lane bind a TUI's", async (t) => {
  const { peers, peer } = fakePeers();
  const { forwards, forwarder } = fakeForwarders();
  const ctx = serverContext(t);
  await createServer({ peer, forwarder })(ctx);
  await ctx.handlers.lane({ sessionID: "ses_l", socket: "/lane.sock" });
  const refused = await ctx.handlers.activate({ sessionID: "ses_l", socket: "/bus.sock", groups: ["team"] });
  assert.equal(refused.rpcError?.type, "sessionbus.conflict");
  assert.equal(peers.length, 0);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  const taken = await ctx.handlers.lane({ sessionID: "ses_a", socket: "/lane2.sock" });
  assert.equal(taken.rpcError?.type, "sessionbus.conflict");
  assert.equal((await ctx.handlers.lane({ sessionID: "ses_l", socket: "/other.sock" })).rpcError?.type, "sessionbus.conflict");
  assert.equal(forwards.length, 1); assert.equal(peers.length, 1);
});

test("server: a lane's connection end releases only its own binding; deletion closes it", async (t) => {
  const { forwards, forwarder } = fakeForwarders();
  const ctx = serverContext(t);
  await createServer({ peer: fakePeers().peer, forwarder })(ctx);
  await ctx.handlers.lane({ sessionID: "ses_l", socket: "/a.sock" });
  forwards[0].end();
  await flush();
  await ctx.handlers.lane({ sessionID: "ses_l", socket: "/b.sock" });
  // The first connection's end, observed again, must not drop the new binding.
  forwards[0].end();
  await flush();
  assert.deepEqual(await ctx.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_l", messageID: "msg_2" }), { content: '{"via":"/b.sock"}' });
  ctx.publish({ type: "session.deleted", data: { sessionID: "ses_l" } });
  for (let i = 0; i < 5 && !forwards[1].disposed; i++) await flush();
  assert.equal(forwards[1].disposed, true);
  await assert.rejects(ctx.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_l", messageID: "msg_3" }), /not active/u);
});

// A native plugin reload: native runs the old instance's cleanup, then the new
// setup, in the same loaded directory, whose ctx.location object is the same.
function reloaded(t, previous) {
  const ctx = serverContext(t);
  ctx.location = previous.location;
  return ctx;
}
// What the instances of a loaded directory have left for the next one.
const handoffRecords = (ctx) => globalThis[Symbol.for("sessionbus.opencode.handoff.v1")].get(ctx.location);

test("server: a reload attaches the previous instance's sessions again, same identity, with no activation", async (t) => {
  const first = fakePeers(), second = fakePeers();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: first.peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"], name: "worker" });
  await ctx.handlers.activate({ sessionID: "ses_b", socket: "/other.sock", groups: [] });
  await cleanup();
  assert.ok(first.peers.every((value) => value.disposed));
  const next = reloaded(t, ctx);
  const cleanupNext = await createServer({ peer: second.peer })(next);
  await flush(); await flush();
  assert.equal(second.peers.length, 2);
  assert.deepEqual(second.peers[0].identity, { product: "opencode-peer", session_id: "ses_a", groups: ["team"], info: { cwd: "/work" }, name: "worker" });
  assert.deepEqual(second.peers[0].env, { SESSIONBUS_SOCKET: "/bus.sock" });
  assert.deepEqual(second.peers[1].identity, { product: "opencode-peer", session_id: "ses_b", groups: [], info: { cwd: "/work" }, name: "native title" });
  assert.deepEqual(second.peers[1].env, { SESSIONBUS_SOCKET: "/other.sock" });
  // The new instance delivers and serves the tool for it.
  assert.deepEqual(await second.peers[0].deliver(undefined, message), { disposition: "injected" });
  assert.equal(next.prompts.length, 1); assert.equal(ctx.prompts.length, 0);
  assert.deepEqual(await next.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_a" }), { content: '{"ok":true}' });
  // A TUI that activates it now finds the Peer; a third instance gets it again.
  assert.deepEqual(await next.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] }), {});
  assert.equal(second.peers.length, 2);
  await cleanupNext();
  const third = fakePeers();
  await createServer({ peer: third.peer })(reloaded(t, next));
  await flush(); await flush();
  assert.deepEqual(third.peers.map((value) => value.identity.session_id).sort(), ["ses_a", "ses_b"]);
});

test("server: nothing is handed over to another loaded directory, or to the same one after an unload", async (t) => {
  const first = fakePeers(), second = fakePeers();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: first.peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  await cleanup();
  // After an unload native builds a new location object for the directory.
  await createServer({ peer: second.peer })(serverContext(t));
  await flush(); await flush();
  assert.equal(second.peers.length, 0);
});

test("server: a session that left before the reload is not attached again", async (t) => {
  const first = fakePeers(), second = fakePeers();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: first.peer })(ctx);
  for (const sessionID of ["ses_deleted", "ses_ended", "ses_kept"]) await ctx.handlers.activate({ sessionID, socket: "/bus.sock", groups: [] });
  ctx.publish({ type: "session.deleted", data: { sessionID: "ses_deleted" } });
  for (let i = 0; i < 5 && !first.peers[0].disposed; i++) await flush();
  // The bus ended this Peer for good while the instance was live.
  await first.peers[1].dispose();
  await cleanup();
  await createServer({ peer: second.peer })(reloaded(t, ctx));
  await flush(); await flush();
  assert.deepEqual(second.peers.map((value) => value.identity.session_id), ["ses_kept"]);
});

test("server: a rename is handed over; a title the bus name grammar refuses keeps the old name", async (t) => {
  const first = fakePeers(), second = fakePeers();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: first.peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: [], name: "worker" });
  ctx.publish({ type: "session.renamed", data: { sessionID: "ses_a", title: "renamed" } });
  for (let i = 0; i < 5 && !first.peers[0].renames.length; i++) await flush();
  ctx.publish({ type: "session.renamed", data: { sessionID: "ses_a", title: "bad　title" } });
  await flush(); await flush();
  await cleanup();
  await createServer({ peer: second.peer })(reloaded(t, ctx));
  await flush(); await flush();
  assert.equal(second.peers.length, 1);
  assert.equal(second.peers[0].identity.name, "renamed");
});

test("server: a TUI activation racing the restore creates one Peer", async (t) => {
  const first = fakePeers(), second = fakePeers();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: first.peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  await cleanup();
  const next = reloaded(t, ctx);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  next.session.get = async ({ sessionID }) => { await gate; return { id: sessionID, title: "native title" }; };
  await createServer({ peer: second.peer })(next);
  // The restore is waiting on native's read; the TUI activates the same session.
  const activation = next.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  await flush();
  assert.equal(second.peers.length, 0);
  release();
  assert.deepEqual(await activation, {});
  await flush(); await flush();
  assert.equal(second.peers.length, 1);
  assert.equal(second.peers[0].identity.session_id, "ses_a");
});

test("server: a TUI activation that attaches before the restore does uses the retained name, groups and socket", async (t) => {
  const first = fakePeers(), second = fakePeers(), third = fakePeers();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: first.peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"], name: "worker" });
  await cleanup();
  // Native has since taken a title the bus name grammar refuses; the bus name stayed worker.
  const next = reloaded(t, ctx);
  let release, reads = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  next.session.get = async ({ sessionID }) => { if (!reads++) await gate; return { id: sessionID, title: "bad　title" }; };
  const cleanupNext = await createServer({ peer: second.peer })(next);
  await flush();
  // The restore's read is still pending. The surviving TUI activates again: its launch name is spent, and its
  // read settles first. Its socket and groups differ here only to show which binding is used.
  const activation = next.handlers.activate({ sessionID: "ses_a", socket: "/other.sock", groups: ["other"] });
  const answer = await Promise.race([activation, flush().then(flush).then(() => "still waiting")]);
  const held = (peers) => peers.map((value) => [value.identity.name, value.identity.groups, value.env.SESSIONBUS_SOCKET, value.disposed]);
  const whileHeld = held(second.peers);
  // Released before anything is asserted, so that a variant without the restore fails here and does not wait.
  release();
  await activation;
  await flush(); await flush();
  assert.deepEqual(answer, {});
  assert.deepEqual(whileHeld, [["worker", ["team"], "/bus.sock", false]]);
  assert.deepEqual(held(second.peers), [["worker", ["team"], "/bus.sock", false]]);
  // The next instance gets that same identity again.
  await cleanupNext();
  await createServer({ peer: third.peer })(reloaded(t, next));
  await flush(); await flush();
  assert.deepEqual(held(third.peers), [["worker", ["team"], "/bus.sock", false]]);
});

test("server: a session native deletes while such an activation waits is not attached, and a new one attaches as its input says", async (t) => {
  const first = fakePeers(), second = fakePeers();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: first.peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"], name: "worker" });
  await cleanup();
  const next = reloaded(t, ctx);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const read = next.session.get;
  next.session.get = async (input) => { await gate; return read(input); };
  await createServer({ peer: second.peer })(next);
  await flush();
  // Both the restore and the activation wait for native when the deletion is announced.
  const activation = next.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  await flush();
  next.publish({ type: "session.deleted", data: { sessionID: "ses_a" } });
  await flush(); await flush();
  release();
  await activation;
  await flush(); await flush();
  assert.equal(second.peers.length, 0);
  assert.equal(next.updates.length, 0);
  assert.equal(handoffRecords(next).has("ses_a"), false);
  // Nothing is retained for it now: an activation is an ordinary first one.
  assert.deepEqual(await next.handlers.activate({ sessionID: "ses_a", socket: "/new.sock", groups: ["new"], name: "fresh" }), {});
  assert.equal(second.peers.length, 1);
  assert.equal(second.peers[0].identity.name, "fresh"); assert.deepEqual(second.peers[0].identity.groups, ["new"]);
  assert.equal(second.peers[0].env.SESSIONBUS_SOCKET, "/new.sock");
});

test("server: an instance cleaned up while its restore waits creates no Peer and leaves the record to the next", async (t) => {
  const first = fakePeers(), second = fakePeers(), third = fakePeers();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: first.peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"], name: "worker" });
  await cleanup();
  // Second instance: native's read is still pending when the next reload comes.
  const middle = reloaded(t, ctx);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  middle.session.get = async ({ sessionID }) => { await gate; return { id: sessionID, title: "native title" }; };
  const cleanupMiddle = await createServer({ peer: second.peer })(middle);
  // An activation in flight in that instance, as a TUI may have.
  const activation = middle.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  await flush();
  await cleanupMiddle();
  const last = reloaded(t, middle);
  await createServer({ peer: third.peer })(last);
  await flush(); await flush();
  assert.equal(third.peers.length, 1);
  // Now the retired instance's reads settle.
  release();
  const answer = await activation;
  await flush(); await flush();
  assert.equal(second.peers.length, 0);
  assert.equal(middle.updates.length, 0);
  assert.equal(answer.rpcError?.type, "sessionbus.not_admitted");
  assert.equal(third.peers.length, 1);
  assert.equal(third.peers[0].disposed, false);
  assert.equal(third.peers[0].identity.name, "worker");
  // The record is still the live instance's: one more reload attaches it again.
  const fourth = fakePeers();
  await createServer({ peer: fourth.peer })(reloaded(t, last));
  await flush(); await flush();
  assert.equal(fourth.peers.length, 1);
});

test("server: a session native deletes while its restore waits is not attached, and its record goes", async (t) => {
  const first = fakePeers(), second = fakePeers(), third = fakePeers();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: first.peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  await cleanup();
  const next = reloaded(t, ctx);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  next.session.get = async ({ sessionID }) => { await gate; return { id: sessionID, title: "native title" }; };
  const cleanupNext = await createServer({ peer: second.peer })(next);
  // No Peer exists yet for it in this instance when native announces the deletion.
  next.publish({ type: "session.deleted", data: { sessionID: "ses_a" } });
  await flush(); await flush();
  release();
  await flush(); await flush();
  assert.equal(second.peers.length, 0);
  assert.equal(next.updates.length, 0);
  await cleanupNext();
  await createServer({ peer: third.peer })(reloaded(t, next));
  await flush(); await flush();
  assert.equal(third.peers.length, 0);
  // The same while native writes the session's grant for the restore.
  const before = fakePeers(), after = fakePeers();
  const other = serverContext(t);
  const cleanupOther = await createServer({ peer: before.peer })(other);
  await other.handlers.activate({ sessionID: "ses_b", socket: "/bus.sock", groups: [] });
  await cleanupOther();
  const writing = reloaded(t, other);
  let written;
  const write = new Promise((resolve) => { written = resolve; });
  writing.session.update = async () => { await write; };
  await createServer({ peer: after.peer })(writing);
  await flush();
  writing.publish({ type: "session.deleted", data: { sessionID: "ses_b" } });
  await flush(); await flush();
  written();
  await flush(); await flush();
  assert.equal(after.peers.length, 0);
  assert.equal(handoffRecords(writing).has("ses_b"), false);
});

test("server: a retained lane keeps its session against a TUI activation that arrives during setup", async (t) => {
  const first = fakeForwarders(), second = fakeForwarders();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: fakePeers().peer, forwarder: first.forwarder })(ctx);
  await ctx.handlers.lane({ sessionID: "ses_l", socket: "/lane.sock" });
  await cleanup();
  const next = reloaded(t, ctx);
  const peers = fakePeers();
  // Native has the handlers as soon as they are registered; the rest of setup is still pending.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const transform = next.tool.transform;
  next.tool.transform = async (callback) => { await gate; return transform(callback); };
  const setup = createServer({ peer: peers.peer, forwarder: second.forwarder })(next);
  for (let i = 0; i < 5 && !next.handlers; i++) await flush();
  const taken = await next.handlers.activate({ sessionID: "ses_l", socket: "/bus.sock", groups: [] });
  assert.equal(taken.rpcError?.type, "sessionbus.conflict");
  assert.equal(peers.peers.length, 0); assert.equal(second.forwards.length, 1);
  release();
  await setup;
  // The worker's bind for its next Run finds that one binding.
  assert.deepEqual(await next.handlers.lane({ sessionID: "ses_l", socket: "/lane.sock" }), {});
  assert.equal(second.forwards.length, 1);
  assert.deepEqual(await next.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_l", messageID: "msg_1" }), { content: '{"via":"/lane.sock"}' });
});

test("server: a session a TUI activated stays the TUI's against a lane bind while its restore waits", async (t) => {
  const first = fakePeers(), second = fakePeers();
  const forwards = fakeForwarders();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: first.peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  await cleanup();
  const next = reloaded(t, ctx);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  next.session.get = async ({ sessionID }) => { await gate; return { id: sessionID, title: "native title" }; };
  await createServer({ peer: second.peer, forwarder: forwards.forwarder })(next);
  // Answered at once, without waiting for native's read.
  const taken = await Promise.race([next.handlers.lane({ sessionID: "ses_a", socket: "/lane.sock" }), flush().then(flush).then(() => "still waiting")]);
  release();
  assert.equal(taken?.rpcError?.type, "sessionbus.conflict");
  assert.equal(forwards.forwards.length, 0);
  await flush(); await flush();
  assert.equal(second.peers.length, 1);
  assert.equal(second.peers[0].identity.session_id, "ses_a");
});

test("server: a setup that fails releases what it created and leaves the records to the next setup", async (t) => {
  const first = fakePeers(), firstForwards = fakeForwarders();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: first.peer, forwarder: firstForwards.forwarder })(ctx);
  await ctx.handlers.lane({ sessionID: "ses_l", socket: "/lane.sock" });
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  await cleanup();
  // The next setup: one of native's registrations is pending, then fails.
  const failing = reloaded(t, ctx);
  const second = fakePeers(), secondForwards = fakeForwarders();
  let fail;
  const gate = new Promise((_resolve, reject) => { fail = reject; });
  failing.tool.transform = async () => { await gate; };
  const setup = createServer({ peer: second.peer, forwarder: secondForwards.forwarder })(failing);
  const outcome = setup.then(() => "returned", (error) => error);
  for (let i = 0; i < 5 && !failing.handlers; i++) await flush();
  // The retained lane is already bound in it.
  assert.equal(secondForwards.forwards.length, 1);
  assert.equal(secondForwards.forwards[0].disposed, false);
  // Native serves a TUI's activation meanwhile.
  assert.deepEqual(await failing.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] }), {});
  assert.equal(second.peers.length, 1);
  fail(new Error("registration failed"));
  const error = await outcome;
  assert.match(String(error?.message), /registration failed/u);
  await flush(); await flush();
  assert.equal(secondForwards.forwards.length, 1);
  assert.equal(secondForwards.forwards[0].disposed, true);
  assert.equal(second.peers.length, 1);
  assert.equal(second.peers[0].disposed, true);
  // Native falls back to the previous generation, whose setup runs again.
  const third = fakePeers(), thirdForwards = fakeForwarders();
  await createServer({ peer: third.peer, forwarder: thirdForwards.forwarder })(reloaded(t, failing));
  await flush(); await flush();
  assert.equal(thirdForwards.forwards.length, 1);
  assert.equal(thirdForwards.forwards[0].socket, "/lane.sock"); assert.equal(thirdForwards.forwards[0].disposed, false);
  assert.deepEqual(third.peers.map((value) => value.identity.session_id), ["ses_a"]);
  assert.equal(third.peers[0].disposed, false);
});

test("server: an activation still in flight when its instance ends answers the transient error", async (t) => {
  const { peers, peer } = fakePeers();
  const ctx = serverContext(t);
  // The bus has not admitted the session when the instance is cleaned up.
  const waiting = (...args) => {
    const value = peer(...args);
    value.admission = (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      value.signal.addEventListener("abort", () => reject(new Error("native owner closed")), { once: true });
    });
    return value;
  };
  const cleanup = await createServer({ peer: waiting })(ctx);
  const admission = ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: [] });
  for (let i = 0; i < 5 && !peers.length; i++) await flush();
  await cleanup();
  assert.equal((await admission).rpcError?.type, "sessionbus.not_admitted");
  assert.equal(peers[0].disposed, true);
  // Native fails the call's read after the instance was cleaned up.
  const other = serverContext(t);
  let fail;
  other.session.get = () => new Promise((_resolve, reject) => { fail = reject; });
  const cleanupOther = await createServer({ peer })(other);
  const read = other.handlers.activate({ sessionID: "ses_b", socket: "/bus.sock", groups: [] });
  await flush();
  await cleanupOther();
  fail(new Error("location closed"));
  assert.equal((await read).rpcError?.type, "sessionbus.not_admitted");
  assert.equal(peers.length, 1);
  // The instance is cleaned up while native writes the session's grant.
  const third = serverContext(t);
  let written;
  const gate = new Promise((resolve) => { written = resolve; });
  third.session.update = async () => { await gate; };
  const cleanupThird = await createServer({ peer })(third);
  const write = third.handlers.activate({ sessionID: "ses_c", socket: "/bus.sock", groups: [] });
  await flush();
  await cleanupThird();
  written();
  assert.equal((await write).rpcError?.type, "sessionbus.not_admitted");
  assert.equal(peers.length, 1);
});

test("server: an instance that ended changes nothing for an event or a lane bind it had not finished", async (t) => {
  const { peer } = fakePeers();
  const forwards = fakeForwarders();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer, forwarder: forwards.forwarder })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: [] });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const read = ctx.session.get;
  ctx.session.get = async (input) => { await gate; return read(input); };
  const binding = ctx.handlers.lane({ sessionID: "ses_l", socket: "/lane.sock" });
  // Native announced a deletion, but the instance is cleaned up before it handles the event.
  ctx.publish({ type: "session.deleted", data: { sessionID: "ses_a" } });
  await cleanup();
  release();
  await assert.rejects(binding, /before this lane was bound/u);
  await flush(); await flush();
  assert.equal(forwards.forwards.length, 0);
  assert.deepEqual([...handoffRecords(ctx).keys()], ["ses_a"]);
});

test("server: a rename the bus has not accepted, or that settles after the instance ended, is not handed over", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const first = fakePeers(), second = fakePeers();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: first.peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: [], name: "worker" });
  // The bus refuses this one.
  first.peers[0].rehello = async () => { throw new Error("name refused"); };
  ctx.publish({ type: "session.renamed", data: { sessionID: "ses_a", title: "refused" } });
  for (let i = 0; i < 5 && !errors.mock.calls.length; i++) await flush();
  assert.equal(errors.mock.calls.length, 1);
  assert.equal(handoffRecords(ctx).get("ses_a").name, "worker");
  // This one is still pending when the instance is cleaned up.
  let accept;
  first.peers[0].rehello = () => new Promise((resolve) => { accept = resolve; });
  ctx.publish({ type: "session.renamed", data: { sessionID: "ses_a", title: "late" } });
  for (let i = 0; i < 5 && !accept; i++) await flush();
  await cleanup();
  accept();
  await flush(); await flush();
  assert.equal(handoffRecords(ctx).get("ses_a").name, "worker");
  await createServer({ peer: second.peer })(reloaded(t, ctx));
  await flush(); await flush();
  assert.equal(second.peers[0].identity.name, "worker");
  assert.equal(errors.mock.calls.length, 1);
});

test("server: a restore that fails after its instance ended, or after an activation took over, drops nothing", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const first = fakePeers(), second = fakePeers(), third = fakePeers();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: first.peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  await cleanup();
  // Ended first: the failure belongs to no live instance.
  const middle = reloaded(t, ctx);
  let fail;
  middle.session.get = () => new Promise((_resolve, reject) => { fail = reject; });
  const cleanupMiddle = await createServer({ peer: second.peer })(middle);
  await flush();
  await cleanupMiddle();
  fail(new Error("read failed"));
  await flush(); await flush();
  assert.equal(errors.mock.calls.length, 0);
  assert.equal(handoffRecords(ctx).has("ses_a"), true);
  // Live, but a TUI's activation attached the session while the restore's read was pending.
  const last = reloaded(t, middle);
  const read = last.session.get;
  let reads = 0;
  last.session.get = (input) => reads++ ? read(input) : new Promise((_resolve, reject) => { fail = reject; });
  await createServer({ peer: third.peer })(last);
  await flush();
  assert.deepEqual(await last.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] }), {});
  fail(new Error("read failed"));
  await flush(); await flush();
  assert.equal(errors.mock.calls.length, 1);
  assert.equal(third.peers.length, 1); assert.equal(third.peers[0].disposed, false);
  assert.equal(handoffRecords(ctx).has("ses_a"), true);
});

test("server: a record that cannot be attached is reported and dropped; setup still succeeds", async (t) => {
  const first = fakePeers(), second = fakePeers(), third = fakePeers();
  const errors = t.mock.method(console, "error", () => {});
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: first.peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_gone", socket: "/bus.sock", groups: [] });
  await ctx.handlers.activate({ sessionID: "ses_kept", socket: "/bus.sock", groups: [] });
  await cleanup();
  const next = reloaded(t, ctx);
  next.session.get = async ({ sessionID }) => {
    if (sessionID === "ses_gone") throw Object.assign(new Error("session not found"), { _tag: "SessionNotFoundError" });
    return { id: sessionID, title: "native title" };
  };
  const cleanupNext = await createServer({ peer: second.peer })(next);
  await flush(); await flush();
  assert.deepEqual(second.peers.map((value) => value.identity.session_id), ["ses_kept"]);
  assert.equal(errors.mock.calls.length, 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /session not found/u);
  // It still serves activations.
  assert.deepEqual(await next.handlers.activate({ sessionID: "ses_new", socket: "/bus.sock", groups: [] }), {});
  await cleanupNext();
  await createServer({ peer: third.peer })(reloaded(t, next));
  await flush(); await flush();
  assert.deepEqual(third.peers.map((value) => value.identity.session_id).sort(), ["ses_kept", "ses_new"]);
});

test("server: a lane binding is handed over; the tool works again without a new bind, which stays idempotent", async (t) => {
  const first = fakeForwarders(), second = fakeForwarders();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: fakePeers().peer, forwarder: first.forwarder })(ctx);
  await ctx.handlers.lane({ sessionID: "ses_l", socket: "/lane.sock" });
  await cleanup();
  assert.equal(first.forwards[0].disposed, true);
  const next = reloaded(t, ctx);
  const peers = fakePeers();
  const cleanupNext = await createServer({ peer: peers.peer, forwarder: second.forwarder })(next);
  assert.equal(second.forwards.length, 1); assert.equal(peers.peers.length, 0);
  assert.deepEqual(await next.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_l", messageID: "msg_1" }), { content: '{"via":"/lane.sock"}' });
  // The worker's bind before its next Run finds the binding.
  assert.deepEqual(await next.handlers.lane({ sessionID: "ses_l", socket: "/lane.sock" }), {});
  assert.equal(second.forwards.length, 1);
  // A TUI still cannot take a lane's session.
  assert.equal((await next.handlers.activate({ sessionID: "ses_l", socket: "/bus.sock", groups: [] })).rpcError?.type, "sessionbus.conflict");
  // The worker ended: its record goes, and the next instance binds nothing.
  second.forwards[0].end();
  await flush();
  await cleanupNext();
  const third = fakeForwarders();
  await createServer({ peer: fakePeers().peer, forwarder: third.forwarder })(reloaded(t, next));
  await flush();
  assert.equal(third.forwards.length, 0);
});

test("server: a lane binding is handed over again at every reload, with nothing reported", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const first = fakeForwarders(), second = fakeForwarders(), third = fakeForwarders();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: fakePeers().peer, forwarder: first.forwarder })(ctx);
  await ctx.handlers.lane({ sessionID: "ses_l", socket: "/lane.sock" });
  await cleanup();
  const next = reloaded(t, ctx);
  const cleanupNext = await createServer({ peer: fakePeers().peer, forwarder: second.forwarder })(next);
  await flush(); await flush();
  await cleanupNext();
  await createServer({ peer: fakePeers().peer, forwarder: third.forwarder })(reloaded(t, next));
  await flush(); await flush();
  assert.equal(second.forwards.length, 1);
  assert.equal(third.forwards.length, 1);
  assert.equal(third.forwards[0].socket, "/lane.sock"); assert.equal(third.forwards[0].disposed, false);
  assert.equal(errors.mock.calls.length, 0);
});

test("server: a retained lane whose connection cannot be created is reported and dropped; setup still succeeds", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const first = fakeForwarders();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: fakePeers().peer, forwarder: first.forwarder })(ctx);
  await ctx.handlers.lane({ sessionID: "ses_l", socket: "/lane.sock" });
  await cleanup();
  const next = reloaded(t, ctx);
  await createServer({ peer: fakePeers().peer, forwarder: () => { throw new Error("cannot connect"); } })(next);
  assert.equal(errors.mock.calls.length, 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /cannot connect/u);
  assert.equal(handoffRecords(next).has("ses_l"), false);
  assert.ok(next.handlers?.lane && next.tool.added && next.hooks?.context);
});

test("server: a lane endpoint that cannot be reached at the restore is dropped; the next bind works as before", async (t) => {
  const first = fakeForwarders(), second = fakeForwarders();
  const ctx = serverContext(t);
  const cleanup = await createServer({ peer: fakePeers().peer, forwarder: first.forwarder })(ctx);
  await ctx.handlers.lane({ sessionID: "ses_l", socket: "/lane.sock" });
  await cleanup();
  const next = reloaded(t, ctx);
  await createServer({ peer: fakePeers().peer, forwarder: second.forwarder })(next);
  assert.equal(second.forwards.length, 1);
  // The restored connection fails: the worker's endpoint is gone.
  second.forwards[0].end();
  await flush();
  assert.equal(handoffRecords(next).has("ses_l"), false);
  await assert.rejects(next.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_l", messageID: "msg_1" }), /not active/u);
  assert.deepEqual(await next.handlers.lane({ sessionID: "ses_l", socket: "/lane2.sock" }), {});
  assert.deepEqual(await next.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_l", messageID: "msg_2" }), { content: '{"via":"/lane2.sock"}' });
});

test("server: something else under the hand-off key, or an unusable record, is ignored without failing setup", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const key = Symbol.for("sessionbus.opencode.handoff.v1");
  // Any instance creates the table.
  await createServer({ peer: fakePeers().peer })(serverContext(t));
  const saved = globalThis[key];
  assert.ok(saved instanceof WeakMap);
  t.after(() => { globalThis[key] = saved; });
  const ctx = serverContext(t);
  saved.set(ctx.location, new Map([["ses_x", { socket: 7, groups: [] }], ["ses_v", { socket: "/bus.sock" }], ["ses_y", null], ["ses_z", { lane: "relative.sock" }], ["ses_w", { lane: 7 }]]));
  const peers = fakePeers(), forwards = fakeForwarders();
  await createServer({ peer: peers.peer, forwarder: forwards.forwarder })(ctx);
  await flush(); await flush();
  assert.equal(peers.peers.length, 0); assert.equal(forwards.forwards.length, 0);
  assert.equal(errors.mock.calls.length, 5);
  assert.equal(saved.get(ctx.location).size, 0);
  // A record that is not a TUI session's does not shape an activation that arrives before it is dropped.
  const early = serverContext(t);
  saved.set(early.location, new Map([["ses_q", { lane: "relative.sock" }]]));
  let registered;
  const pending = new Promise((resolve) => { registered = resolve; });
  const transform = early.tool.transform;
  early.tool.transform = async (callback) => { await pending; return transform(callback); };
  const starting = createServer({ peer: peers.peer, forwarder: forwards.forwarder })(early);
  for (let i = 0; i < 5 && !early.handlers; i++) await flush();
  assert.deepEqual(await early.handlers.activate({ sessionID: "ses_q", socket: "/bus.sock", groups: ["team"], name: "named" }), {});
  assert.equal(peers.peers.length, 1); assert.equal(peers.peers[0].identity.name, "named");
  registered();
  await starting;
  await flush(); await flush();
  assert.equal(peers.peers[0].disposed, false); assert.equal(typeof saved.get(early.location).get("ses_q")?.socket, "string");
  // No location object to key by: that instance shares nothing and setup still succeeds.
  const nowhere = serverContext(t);
  nowhere.location = undefined;
  await createServer({ peer: fakePeers().peer })(nowhere);
  assert.ok(nowhere.handlers?.activate);
  // A value of another shape under the key: this instance shares nothing and still works.
  globalThis[key] = "from another build";
  const other = serverContext(t);
  await createServer({ peer: peers.peer })(other);
  assert.deepEqual(await other.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: [] }), {});
  assert.equal(peers.peers.length, 2);
  assert.equal(globalThis[key], "from another build");
});

function tuiContext() {
  const listeners = new Map(), calls = [], toasts = [];
  let route = { type: "home" };
  const effects = new Set();
  const rerun = () => { for (const effect of [...effects]) effect(); };
  const ctx = {
    location: { directory: "/work" },
    calls, toasts,
    fail: undefined,
    missing: new Set(), gets: [], holdOnce: new Set(), held: [], holdFound: new Set(),
    client: {
      session: {
        get: async ({ sessionID }) => {
          ctx.gets.push(sessionID);
          const notFound = { _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` };
          // A read whose 404 is still settling when native announces the session.
          if (ctx.holdOnce.delete(sessionID)) return new Promise((_resolve, reject) => ctx.held.push(() => reject(notFound)));
          // A successful read still settling when the TUI closes.
          if (ctx.holdFound.delete(sessionID)) return new Promise((resolve) => ctx.held.push(() => resolve({ id: sessionID })));
          if (ctx.missing.has(sessionID)) throw notFound;
          return { id: sessionID };
        },
        update: async (input) => { calls.push(["update", input]); },
        create: async (input) => { calls.push(["create", input]); return { id: "ses_new", location: input.location }; },
      },
      rpc: () => ({ activate: async (input, options) => { calls.push(["activate", input, options]); if (ctx.fail) throw ctx.fail; return {}; } }),
    },
    data: {
      session: { get: (id) => ({ id, location: { directory: "/work" } }) },
      on: (type, handler) => { listeners.set(type, handler); return () => listeners.delete(type); },
    },
    ui: { router: { current: () => route, navigate: (destination) => { calls.push(["navigate", destination]); route = destination; rerun(); } }, toast: { show: (value) => toasts.push(value) } },
    show(id) { route = { type: "session", sessionID: id }; rerun(); },
    // Native's server-synced location arriving or changing.
    locate(location) { ctx.location = location; rerun(); },
    emit(type, event = {}) { listeners.get(type)?.(event); },
    listening: (type) => listeners.has(type),
  };
  const solid = { createRoot: (body) => body(() => effects.clear()), createEffect: (body) => { effects.add(body); body(); } };
  return { ctx, solid };
}
const launch = (extra = {}) => ({ SESSIONBUS_OPENCODE_LAUNCH: JSON.stringify({ pid: process.pid, socket: "/bus.sock", name: "worker", groups: ["team"], ...extra }) });

test("tui: inactive without its own launch; names only the first shown session once", async () => {
  for (const environment of [{}, launch({ pid: process.pid + 1 }), { SESSIONBUS_OPENCODE_LAUNCH: "{" }]) {
    const { ctx, solid } = tuiContext();
    assert.equal(await createTui(environment, { solid })(ctx), undefined);
    assert.equal(ctx.listening("server.connected"), false);
  }
  const { ctx, solid } = tuiContext();
  await createTui(launch(), { solid })(ctx);
  ctx.show("ses_a"); await flush();
  ctx.show("ses_b"); await flush();
  ctx.show("ses_a"); await flush();
  assert.deepEqual(ctx.calls, [
    ["update", { sessionID: "ses_a", title: "worker" }],
    ["activate", { sessionID: "ses_a", socket: "/bus.sock", groups: ["team"], name: "worker" }, { location: { directory: "/work" } }],
    ["activate", { sessionID: "ses_b", socket: "/bus.sock", groups: ["team"] }, { location: { directory: "/work" } }],
  ]);
});

test("tui: a launch that selects no session creates one, named, and activates it", async () => {
  const { ctx, solid } = tuiContext();
  await createTui(launch({ create: true }), { solid })(ctx);
  await flush(); await flush();
  assert.deepEqual(ctx.calls, [
    ["create", { title: "worker", location: { directory: "/work" } }],
    ["navigate", { type: "session", sessionID: "ses_new" }],
    ["update", { sessionID: "ses_new", title: "worker" }],
    ["activate", { sessionID: "ses_new", socket: "/bus.sock", groups: ["team"], name: "worker" }, { location: { directory: "/work" } }],
  ]);
  const { ctx: other, solid: otherSolid } = tuiContext();
  await createTui(launch(), { solid: otherSolid })(other);
  await flush();
  assert.equal(other.calls.length, 0);
});

test("tui: launch-and-wait creates once, when native's location becomes available, never after cleanup", async () => {
  const { ctx, solid } = tuiContext();
  ctx.location = undefined;
  await createTui(launch({ create: true }), { solid })(ctx);
  await flush();
  assert.deepEqual(ctx.calls, []);
  ctx.locate({ directory: "/work" }); await flush(); await flush();
  ctx.locate({ directory: "/work" }); await flush();
  assert.deepEqual(ctx.calls, [
    ["create", { title: "worker", location: { directory: "/work" } }],
    ["navigate", { type: "session", sessionID: "ses_new" }],
    ["update", { sessionID: "ses_new", title: "worker" }],
    ["activate", { sessionID: "ses_new", socket: "/bus.sock", groups: ["team"], name: "worker" }, { location: { directory: "/work" } }],
  ]);
  const { ctx: early, solid: earlySolid } = tuiContext();
  early.location = undefined;
  const cleanup = await createTui(launch({ create: true }), { solid: earlySolid })(early);
  await cleanup();
  early.locate({ directory: "/work" }); await flush();
  assert.deepEqual(early.calls, []);
});

test("tui: a session shown before native creates it is activated, named, once native announces it", async () => {
  const { ctx, solid } = tuiContext();
  ctx.missing.add("ses_prompt");
  const cleanup = await createTui(launch(), { solid })(ctx);
  ctx.show("ses_prompt"); await flush(); await flush();
  assert.deepEqual(ctx.calls, []); assert.deepEqual(ctx.toasts, []);
  ctx.emit("session.created", { type: "session.created", data: { sessionID: "ses_other" } }); await flush();
  assert.deepEqual(ctx.calls, []);
  ctx.missing.delete("ses_prompt");
  ctx.emit("session.created", { type: "session.created", data: { sessionID: "ses_prompt" } }); await flush(); await flush();
  ctx.emit("session.created", { type: "session.created", data: { sessionID: "ses_prompt" } }); await flush();
  assert.deepEqual(ctx.calls, [
    ["update", { sessionID: "ses_prompt", title: "worker" }],
    ["activate", { sessionID: "ses_prompt", socket: "/bus.sock", groups: ["team"], name: "worker" }, { location: { directory: "/work" } }],
  ]);
  assert.deepEqual(ctx.gets, ["ses_prompt", "ses_prompt"]);
  // After cleanup a later announcement activates nothing.
  ctx.missing.add("ses_late"); ctx.show("ses_late"); await flush();
  await cleanup();
  ctx.missing.delete("ses_late");
  ctx.emit("session.created", { type: "session.created", data: { sessionID: "ses_late" } }); await flush();
  assert.equal(ctx.calls.length, 2); assert.equal(ctx.listening("session.created"), false);
});

test("tui: a reconnect before native creates the shown session keeps its pending name", async () => {
  const { ctx, solid } = tuiContext();
  ctx.missing.add("ses_prompt");
  await createTui(launch(), { solid })(ctx);
  ctx.show("ses_prompt"); await flush();
  // not found, reconnect, not found again (that attempt carries no name), then created
  ctx.emit("server.connected"); await flush(); await flush();
  assert.deepEqual(ctx.calls, []); assert.deepEqual(ctx.gets, ["ses_prompt", "ses_prompt"]);
  ctx.missing.delete("ses_prompt");
  ctx.emit("session.created", { type: "session.created", data: { sessionID: "ses_prompt" } }); await flush(); await flush();
  assert.deepEqual(ctx.calls, [
    ["update", { sessionID: "ses_prompt", title: "worker" }],
    ["activate", { sessionID: "ses_prompt", socket: "/bus.sock", groups: ["team"], name: "worker" }, { location: { directory: "/work" } }],
  ]);
});

test("tui: native's session.created while the earlier read settles still activates, once; the late 404 changes nothing", async () => {
  const { ctx, solid } = tuiContext();
  ctx.holdOnce.add("ses_prompt");
  await createTui(launch(), { solid })(ctx);
  ctx.show("ses_prompt"); await flush();
  assert.equal(ctx.held.length, 1);
  // Native's sole announcement arrives before the first read's 404 settles.
  ctx.emit("session.created", { type: "session.created", data: { sessionID: "ses_prompt" } }); await flush(); await flush();
  for (const release of ctx.held) release();
  await flush(); await flush();
  const activated = [
    ["update", { sessionID: "ses_prompt", title: "worker" }],
    ["activate", { sessionID: "ses_prompt", socket: "/bus.sock", groups: ["team"], name: "worker" }, { location: { directory: "/work" } }],
  ];
  assert.deepEqual(ctx.calls, activated);
  assert.deepEqual(ctx.gets, ["ses_prompt", "ses_prompt"]); assert.deepEqual(ctx.toasts, []);
  // The late 404 left nothing pending: a duplicate announcement starts nothing.
  ctx.emit("session.created", { type: "session.created", data: { sessionID: "ses_prompt" } }); await flush(); await flush();
  assert.deepEqual(ctx.calls, activated); assert.equal(ctx.gets.length, 2);
});

test("tui: cleanup while a read settles stops that attempt before any update or activation", async () => {
  const { ctx, solid } = tuiContext();
  ctx.holdFound.add("ses_a");
  const cleanup = await createTui(launch(), { solid })(ctx);
  ctx.show("ses_a"); await flush();
  assert.equal(ctx.held.length, 1);
  await cleanup();
  for (const release of ctx.held) release();
  await flush(); await flush();
  assert.deepEqual(ctx.calls, []); assert.deepEqual(ctx.toasts, []);
});

test("tui: a plugin instance re-created in the same TUI does not repeat the launch's create or name", async () => {
  const { ctx, solid } = tuiContext();
  const environment = launch({ create: true });
  const cleanup = await createTui(environment, { solid })(ctx);
  await flush(); await flush();
  assert.deepEqual(ctx.calls.map((call) => call[0]), ["create", "navigate", "update", "activate"]);
  await cleanup();
  assert.deepEqual(JSON.parse(environment.SESSIONBUS_OPENCODE_LAUNCH), { pid: process.pid, socket: "/bus.sock", name: "", groups: ["team"], create: false });
  // Native re-creates the plugin (a hot reload) in the same TUI, still showing the
  // session, which the user may have renamed meanwhile: no create, no -n again.
  const { ctx: again, solid: againSolid } = tuiContext();
  await createTui(environment, { solid: againSolid })(again);
  again.show("ses_new"); await flush(); await flush();
  assert.deepEqual(again.calls, [["activate", { sessionID: "ses_new", socket: "/bus.sock", groups: ["team"] }, { location: { directory: "/work" } }]]);
});

test("tui: a session the bus has not admitted yet stays activated on the next native event", async () => {
  const { ctx, solid } = tuiContext();
  ctx.fail = Object.assign(new Error("the bus has not admitted this session yet; still connecting"), { type: "sessionbus.not_admitted" });
  await createTui(launch({ name: "" }), { solid })(ctx);
  ctx.show("ses_a"); await flush(); await flush();
  assert.equal(ctx.toasts.length, 1); assert.match(ctx.toasts[0].message, /not admitted this session yet/u);
  // The bus becomes reachable; the next native event activates the same session again.
  ctx.fail = undefined;
  ctx.emit("server.connected"); await flush(); await flush();
  assert.deepEqual(ctx.calls.filter((call) => call[0] === "activate").map((call) => call[1].sessionID), ["ses_a", "ses_a"]);
  // A permanent failure still ends that session's activation.
  ctx.fail = Object.assign(new Error("invalid_hello"), { type: "rpc.internal" });
  ctx.emit("server.connected"); await flush(); await flush();
  ctx.fail = undefined;
  ctx.emit("server.connected"); await flush(); await flush();
  assert.equal(ctx.calls.filter((call) => call[0] === "activate").length, 3);
});

test("tui: native unload of its directory and reconnect each trigger one activation; cleanup stops all", async () => {
  const { ctx, solid } = tuiContext();
  const cleanup = await createTui(launch({ name: "" }), { solid })(ctx);
  ctx.show("ses_a"); await flush();
  ctx.calls.length = 0;
  ctx.emit("location.shutdown", { location: { directory: "/elsewhere" } }); await flush();
  assert.equal(ctx.calls.length, 0);
  ctx.emit("location.shutdown", { location: { directory: "/work" } }); await flush();
  ctx.emit("server.connected"); await flush();
  assert.deepEqual(ctx.calls.map(([kind, input]) => [kind, input.sessionID]), [["activate", "ses_a"], ["activate", "ses_a"]]);
  cleanup();
  ctx.emit("server.connected"); await flush();
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.listening("location.shutdown"), false);
});

test("tui: an unavailable service waits for the next native event; any other failure is reported and ends it", async () => {
  const { ctx, solid } = tuiContext();
  await createTui(launch({ name: "" }), { solid })(ctx);
  ctx.fail = { type: "rpc.unavailable", message: "location closed" };
  ctx.show("ses_a"); await flush();
  assert.equal(ctx.toasts.length, 1);
  ctx.fail = undefined;
  ctx.emit("server.connected"); await flush();
  assert.equal(ctx.calls.length, 2);
  ctx.fail = { type: "rpc.method_not_found", message: "no sessionbus plugin" };
  ctx.emit("server.connected"); await flush();
  ctx.emit("server.connected"); await flush();
  assert.equal(ctx.calls.length, 3);
  assert.match(ctx.toasts.at(-1).message, /no sessionbus plugin/u);
});

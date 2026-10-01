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
  ctx.rpc = { register: async (_contract, handlers) => { ctx.handlers = handlers; return { dispose: async () => {} }; } };
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

test("server: a native Task child of an attached session becomes its own peer at creation with the parent's groups", async (t) => {
  const { peers, peer } = fakePeers();
  const ctx = serverContext(t);
  ctx.session.get = async ({ sessionID }) => ({ id: sessionID, title: sessionID === "ses_child" ? "child task" : "native title", parentID: { ses_child: "ses_a", ses_grandchild: "ses_child" }[sessionID] });
  const cleanup = await createServer({ peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"], name: "worker" });
  ctx.publish({ type: "session.created", data: { sessionID: "ses_unrelated", title: "other" } });
  ctx.publish({ type: "session.created", data: { sessionID: "ses_child", parentID: "ses_a", title: "child task" } });
  ctx.publish({ type: "session.created", data: { sessionID: "ses_grandchild", parentID: "ses_child" } });
  for (let i = 0; i < 10 && peers.length < 3; i++) await flush();
  assert.deepEqual(peers.map((value) => [value.identity.session_id, value.identity.name, value.identity.groups, value.env.SESSIONBUS_SOCKET]), [
    ["ses_a", "worker", ["team"], "/bus.sock"],
    ["ses_child", "child task", ["team"], "/bus.sock"],
    ["ses_grandchild", "native title", ["team"], "/bus.sock"],
  ]);
  // The child's tool acts as the child, not the parent.
  await ctx.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_child" });
  assert.deepEqual(peers[1].actions, [["list", {}]]); assert.deepEqual(peers[0].actions, []);
  await assert.rejects(ctx.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_unrelated" }), /not active/u);
  // Its first model request keeps the tool and does not attach it again.
  const first = { sessionID: "ses_child", tools: { sessionbus: {} } };
  await ctx.hooks.context(first);
  assert.deepEqual(Object.keys(first.tools), ["sessionbus"]); assert.equal(peers.length, 3);
  await cleanup();
  assert.ok(peers.every((value) => value.disposed));
});

test("server: a Task child with no session.created (native reuse) attaches at its model request as its own peer", async (t) => {
  const { peers, peer } = fakePeers();
  const ctx = serverContext(t);
  const parents = { ses_child: "ses_a", ses_grandchild: "ses_child", ses_stray: "ses_not_attached" };
  const titles = { ses_child: "child task" };
  let lookups = 0;
  ctx.session.get = async ({ sessionID }) => { lookups++; return { id: sessionID, title: titles[sessionID] || "native title", parentID: parents[sessionID] }; };
  const cleanup = await createServer({ peer })(ctx);
  // No attached session: unrelated requests cost no lookup and lose the tool.
  const early = { sessionID: "ses_unrelated", tools: { sessionbus: {} } };
  await ctx.hooks.context(early);
  assert.equal(lookups, 0); assert.deepEqual(Object.keys(early.tools), []);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"], name: "worker" });
  // An existing child native continues: no session.created reaches the plugin.
  const child = { sessionID: "ses_child", tools: { sessionbus: {} } };
  await ctx.hooks.context(child);
  const grandchild = { sessionID: "ses_grandchild", tools: { sessionbus: {} } };
  await ctx.hooks.context(grandchild);
  const unrelated = { sessionID: "ses_unrelated", tools: { sessionbus: {} } };
  await ctx.hooks.context(unrelated);
  // A child of a session that is not attached is never adopted.
  const stray = { sessionID: "ses_stray", tools: { sessionbus: {} } };
  await ctx.hooks.context(stray);
  assert.deepEqual(Object.keys(child.tools), ["sessionbus"]); assert.deepEqual(Object.keys(grandchild.tools), ["sessionbus"]);
  assert.deepEqual(Object.keys(unrelated.tools), []); assert.deepEqual(Object.keys(stray.tools), []);
  assert.deepEqual(peers.map((value) => [value.identity.session_id, value.identity.name, value.identity.groups, value.env.SESSIONBUS_SOCKET]), [
    ["ses_a", "worker", ["team"], "/bus.sock"],
    ["ses_child", "child task", ["team"], "/bus.sock"],
    ["ses_grandchild", "native title", ["team"], "/bus.sock"],
  ]);
  // The child's tool acts as the child; a second request does not attach again.
  await ctx.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_child" });
  assert.deepEqual(peers[1].actions, [["list", {}]]); assert.deepEqual(peers[0].actions, []);
  await ctx.hooks.context({ sessionID: "ses_child", tools: { sessionbus: {} } });
  assert.equal(peers.length, 3);
  // A failing lookup never throws into native; the tool is removed for that request.
  ctx.session.get = async () => { throw new Error("lookup failed"); };
  const failing = { sessionID: "ses_other_child", tools: { sessionbus: {} } };
  await ctx.hooks.context(failing);
  assert.deepEqual(Object.keys(failing.tools), []);
  await cleanup();
  assert.ok(peers.every((value) => value.disposed));
});

test("server: an activated session keeps the Sessionbus tool through one last allow rule; sub-agents get none", async (t) => {
  const { peers, peer } = fakePeers();
  const ctx = serverContext(t);
  const grant = { action: "sessionbus", resource: "*", effect: "allow" };
  const deny = { action: "sessionbus", resource: "*", effect: "deny" };
  const ask = { action: "shell", resource: "*", effect: "ask" };
  const rules = { ses_deny: [deny, ask], ses_granted: [ask, grant], ses_buried: [grant, deny], ses_child: [deny], ses_reused: [deny] };
  const parents = { ses_child: "ses_deny", ses_reused: "ses_deny" };
  ctx.session.get = async ({ sessionID }) => ({ id: sessionID, title: "native title", parentID: parents[sessionID], permissions: rules[sessionID] });
  const cleanup = await createServer({ peer })(ctx);
  for (const sessionID of ["ses_deny", "ses_granted", "ses_buried", "ses_none"]) await ctx.handlers.activate({ sessionID, socket: "/bus.sock", groups: ["team"] });
  assert.deepEqual(ctx.updates, [
    { sessionID: "ses_deny", permissions: [deny, ask, grant] },
    { sessionID: "ses_buried", permissions: [grant, deny, grant] },
    { sessionID: "ses_none", permissions: [grant] },
  ]);
  // Native sub-agents are attached best effort, without a rule of their own.
  ctx.publish({ type: "session.created", data: { sessionID: "ses_child", parentID: "ses_deny" } });
  for (let i = 0; i < 10 && peers.length < 5; i++) await flush();
  await ctx.hooks.context({ sessionID: "ses_reused", tools: { sessionbus: {} } });
  assert.deepEqual(peers.map((value) => value.identity.session_id), ["ses_deny", "ses_granted", "ses_buried", "ses_none", "ses_child", "ses_reused"]);
  assert.equal(ctx.updates.length, 3);
  // A managed TUI showing a sub-agent attached best effort grants it, keeping its Peer.
  await ctx.handlers.activate({ sessionID: "ses_child", socket: "/bus.sock", groups: ["team"] });
  assert.deepEqual(ctx.updates.at(-1), { sessionID: "ses_child", permissions: [deny, grant] });
  assert.equal(peers.length, 6);
  // An activation that cannot be granted is not attached: no Peer without its
  // tool, and an existing Peer is left as it is.
  ctx.session.update = async () => { throw new Error("update failed"); };
  await assert.rejects(ctx.handlers.activate({ sessionID: "ses_failed", socket: "/bus.sock", groups: ["team"] }), /update failed/u);
  await assert.rejects(ctx.handlers.activate({ sessionID: "ses_reused", socket: "/bus.sock", groups: ["team"] }), /update failed/u);
  assert.equal(peers.length, 6); assert.ok(peers.every((value) => !value.disposed));
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
  for (let i = 0; i < 5 && !peers[0].renames.length; i++) await flush();
  await flush();
  assert.deepEqual(peers[0].renames, [["renamed worker", { cwd: "/work" }]]);
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
function tuiContext() {
  const listeners = new Map(), calls = [], toasts = [];
  let route = { type: "home" };
  const effects = new Set();
  const rerun = () => { for (const effect of [...effects]) effect(); };
  const ctx = {
    location: { directory: "/work" },
    calls, toasts,
    fail: undefined,
    client: {
      session: {
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

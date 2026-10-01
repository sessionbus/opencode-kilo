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
  const ctx = { location: { directory: "/work" }, prompts: [] };
  ctx.rpc = { register: async (_contract, handlers) => { ctx.handlers = handlers; return { dispose: async () => {} }; } };
  ctx.session = {
    get: async ({ sessionID }) => ({ id: sessionID, title: "native title" }),
    prompt: async (input) => { ctx.prompts.push(input); return prompt(input); },
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
  const held = [];
  ctx.session.get = ({ sessionID }) => new Promise((resolve) => held.push(() => resolve({ id: sessionID, title: "native title" })));
  const cleanup = await createServer({ peer })(ctx);
  const first = ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  const second = ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  for (let i = 0; i < 5 && held.length < 2; i++) await flush();
  assert.equal(held.length, 2);
  for (const release of held) release();
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

test("server: a native Task child acts for its activated ancestor; unrelated sessions do not", async (t) => {
  const { peers, peer } = fakePeers();
  const ctx = serverContext(t);
  const parents = { ses_child: "ses_a", ses_grandchild: "ses_child", ses_orphan: undefined };
  ctx.session.get = async ({ sessionID }) => ({ id: sessionID, title: "native title", parentID: parents[sessionID] });
  await createServer({ peer })(ctx);
  await ctx.handlers.activate({ sessionID: "ses_a", socket: "/bus.sock", groups: ["team"] });
  assert.deepEqual(await ctx.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_grandchild" }), { content: '{"ok":true}' });
  assert.deepEqual(peers[0].actions, [["list", {}]]);
  await assert.rejects(ctx.tool.added.execute({ action: "list", arguments: {} }, { sessionID: "ses_orphan" }), /not active/u);
  const child = { sessionID: "ses_child", tools: { sessionbus: {} } }, orphan = { sessionID: "ses_orphan", tools: { sessionbus: {} } };
  await ctx.hooks.context(child); await ctx.hooks.context(orphan);
  assert.deepEqual(Object.keys(child.tools), ["sessionbus"]); assert.deepEqual(Object.keys(orphan.tools), []);
  assert.equal(peers.length, 1);
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
  let route = { type: "home" }, effect;
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
    ui: { router: { current: () => route, navigate: (destination) => { calls.push(["navigate", destination]); route = destination; effect(); } }, toast: { show: (value) => toasts.push(value) } },
    show(id) { route = { type: "session", sessionID: id }; effect(); },
    emit(type, event = {}) { listeners.get(type)?.(event); },
    listening: (type) => listeners.has(type),
  };
  const solid = { createRoot: (body) => body(() => { effect = () => {}; }), createEffect: (body) => { effect = body; body(); } };
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

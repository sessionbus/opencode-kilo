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

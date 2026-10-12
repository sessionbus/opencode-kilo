// SPDX-License-Identifier: MIT
import { nativeProduct } from "./profile.mjs";

import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import net from "node:net";
import test from "node:test";
import { Connection } from "@sessionbus/kit";
import { createTui } from "./tui.mjs";
import { SessionbusForwarder } from "./forward.mjs";

async function fixture(t) {
  const directory = await mkdtemp("/tmp/oc-tui-");
  const binding = { directory, pid: process.ppid, socket: directory + "/bus", name: "first", groups: ["one", "two"] };
  const events = new EventEmitter();
  let life = new AbortController(), disposals = new Set();
  const sockets = new Set(), wires = new Map(), titles = new Map(), hellos = [], updates = [], creates = [], wakes = [];
  let stallCreate = false;
  let releaseCreate;
  const server = net.createServer((stream) => {
    sockets.add(stream); stream.once("close", () => sockets.delete(stream));
    const wire = new Connection(stream, false, (request) => {
      if (request.method === "session.hello") { hellos.push(request.params); wires.set(request.params.session_id, wire); void wire.result(request, {}); }
      else void wire.result(request, { sessions: [] });
    });
  });
  server.listen(binding.socket); await once(server, "listening");
  let effect, disposedRoot = false;
  // This is a controlled host-reactivity seam. Actual host Solid/Bun resolution
  // is an installed composition gate, not claimed by this Node fixture.
  const solid = { createRoot(callback) { callback(() => { disposedRoot = true; }); }, createEffect(callback) { effect = callback; callback(); } };
  const api = { route: { current: { name: "home" }, navigate(name, params) { api.route.current = { name, params }; effect?.(); } }, lifecycle: { signal: life.signal, onDispose(callback) { disposals.add(callback); return () => disposals.delete(callback); } },
    event: { on(type, callback) { events.on(type, callback); return () => events.off(type, callback); } },
    client: { session: {
      async get({ sessionID }) { return { response: { status: 200 }, data: { id: sessionID, title: titles.get(sessionID) || "", directory: "/native" } }; },
      async status() { return { response: { status: 200 }, data: {} }; },
      async update(params) { updates.push(params); titles.set(params.sessionID, params.title); return { response: { status: 200 }, data: { id: params.sessionID, title: params.title, directory: "/native" } }; },
      async promptAsync(params) { wakes.push(params); return { response: { status: 204 } }; },
      async create(params, options) {
        creates.push(params);
        // A stalled request ends only through its abort signal, if it has one.
        if (stallCreate) await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
        if (releaseCreate) await releaseCreate.promise;
        return { response: { status: 200 }, data: { id: "ses_created", title: params.title || "", directory: "/native" } };
      },
    }, permission: { async list() { return { response: { status: 200 }, data: [] }; } }, question: { async list() { return { response: { status: 200 }, data: [] }; } } },
    state: { session: { permission: () => [], question: () => [] } },
  };
  const close = async () => { life.abort(); await Promise.all([...disposals].map((callback) => callback())); };
  t.after(async () => { await close(); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { directory, binding, api, solid, hellos, updates, creates, wakes, wires, close,
    reopen() {
      life = new AbortController(); disposals = new Set();
      const set = disposals;
      return { ...api, lifecycle: { signal: life.signal, onDispose(callback) { set.add(callback); return () => set.delete(callback); } } };
    },
    holdCreate() {
      let resolve;
      releaseCreate = { promise: new Promise((yes) => { resolve = yes; }) };
      return () => { resolve(); releaseCreate = undefined; };
    },
    title(id, value) { titles.set(id, value); },
    stall() { stallCreate = true; }, rootDisposed: () => disposedRoot, route(id) { api.route.current = { name: "session", params: { sessionID: id } }; effect(); } };
}

test("toggle-on in the same function restores exact ownership and inbound wake without a second create or rename", { timeout: 5000 }, async (t) => {
  const f = await fixture(t), env = { [nativeProduct.launchEnv]: JSON.stringify({ ...f.binding, create: true }) };
  const start = createTui(env, { solid: f.solid });
  await start(f.api);
  const first = new SessionbusForwarder(f.directory + "/actions.sock");
  await first.action("list", {}, { sessionID: "ses_created", messageID: "msg_first" });
  await first.dispose();
  await f.close();
  await assert.rejects(stat(f.directory + "/actions.ready"), { code: "ENOENT" });
  assert.equal((await stat(f.directory + "/owner.claim")).size, 0);
  // A foreign function (as in another module/process) still cannot acquire it.
  await assert.rejects(createTui(env, { solid: f.solid })(f.reopen()), { code: "EEXIST" });
  await f.close();
  f.title("ses_created", "native title while off");
  await start(f.reopen());
  const second = new SessionbusForwarder(f.directory + "/actions.sock");
  t.after(() => second.dispose());
  await second.action("list", {}, { sessionID: "ses_created", messageID: "msg_second" });
  const restored = f.hellos.at(-1);
  assert.equal(restored.session_id, "ses_created");
  assert.equal(restored.name, "native title while off");
  assert.deepEqual(restored.groups, f.binding.groups);
  assert.equal(f.creates.length, 1);
  assert.deepEqual(f.updates, [{ sessionID: "ses_created", title: "first" }]);
  const receipt = await f.wires.get("ses_created").call("message.deliver", { message_id: "toggle_wake", body: "new input", from: { session_id: "controller", product: "test", groups: [] } });
  assert.equal(receipt.disposition, "written");
  assert.equal(f.wakes.length, 1);
  assert.match(f.wakes[0].parts[0].text, /toggle_wake/);
});

test("pending disposal refuses toggle-on and cannot remove a later activation's ready marker", { timeout: 5000 }, async (t) => {
  const f = await fixture(t), release = f.holdCreate();
  const start = createTui({ [nativeProduct.launchEnv]: JSON.stringify({ ...f.binding, create: true }) }, { solid: f.solid });
  const setup = start(f.api);
  while (!f.creates.length) await new Promise((resolve) => setImmediate(resolve));
  const closing = f.close();
  await assert.rejects(start(f.reopen()), { code: "EEXIST" });
  release();
  await setup; await closing;
  await start(f.reopen());
  assert.equal(f.creates.length, 1, "uncertain first creation is never repeated");
  assert.equal((await stat(f.directory + "/actions.ready")).size, 0);
  await closing;
  assert.equal((await stat(f.directory + "/actions.ready")).size, 0, "old disposal has no authority over the successor");
});

test("failed cleanup keeps the grant reserved instead of allowing an overlapping owner", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const register = f.api.lifecycle.onDispose;
  f.api.lifecycle.onDispose = (callback) => {
    const unregister = register(callback);
    return () => { unregister(); throw new Error("cleanup failed"); };
  };
  const start = createTui({ [nativeProduct.launchEnv]: JSON.stringify(f.binding) }, { solid: f.solid });
  await start(f.api);
  await assert.rejects(f.close(), /cleanup failed/);
  await assert.rejects(start(f.reopen()), { code: "EEXIST" });
  assert.equal((await stat(f.directory + "/owner.claim")).size, 0);
});

test("ordinary TUI is inert before loading host reactivity or creating resources", async (t) => {
  const f = await fixture(t);
  await createTui({})(f.api);
  assert.deepEqual(await readdir(f.directory), ["bus"]);
  assert.equal(f.hellos.length, 0);
});

test("managed home has endpoint but no fake session; actual tool and route own exact IDs", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await createTui({ [nativeProduct.launchEnv]: JSON.stringify(f.binding) }, { solid: f.solid })(f.api);
  assert.equal((await stat(f.directory + "/actions.ready")).size, 0);
  assert.equal(f.hellos.length, 0);
  const client = new SessionbusForwarder(f.directory + "/actions.sock");
  t.after(() => client.dispose());
  await client.action("list", {}, { sessionID: "ses_child", messageID: "msg_tool" });
  assert.equal(f.hellos[0].session_id, "ses_child"); assert.deepEqual(f.updates, []);
  f.route("ses_selected");
  await client.action("list", {}, { sessionID: "ses_selected", messageID: "msg_selected" });
  // Disposal joins the route's acknowledged rename; no arbitrary delay.
  await client.dispose(); await f.close();
  assert.deepEqual(f.updates, [{ sessionID: "ses_selected", title: "first" }]);
  assert.equal(f.rootDisposed(), true);
  assert.equal((await stat(f.directory + "/owner.claim")).size, 0, "helper never deletes launch claim");
  assert.deepEqual(f.creates, [], "a launch without create gets no session of its own");
});

test("a launch that selects no session creates one titled with its name and shows it, once", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await assert.rejects(createTui({ [nativeProduct.launchEnv]: JSON.stringify({ ...f.binding, create: false }) }, { solid: f.solid })(f.api), /invalid managed/);
  const start = createTui({ [nativeProduct.launchEnv]: JSON.stringify({ ...f.binding, create: true }) }, { solid: f.solid });
  await start(f.api);
  assert.deepEqual(f.creates, [{ title: "first" }]);
  assert.deepEqual(f.api.route.current, { name: "session", params: { sessionID: "ses_created" } });
  // Shown, it is selected like any other route: its owner says hello and takes the name.
  for (let i = 0; i < 50 && !f.hellos.some((hello) => hello.session_id === "ses_created"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(f.hellos.some((hello) => hello.session_id === "ses_created"));
  // A second start in the same launch is refused by the claim and creates nothing.
  await assert.rejects(start(f.api), /EEXIST/);
  assert.equal(f.creates.length, 1);
  await f.close();
  assert.deepEqual(f.updates, [{ sessionID: "ses_created", title: "first" }]);
});

test("overlapping TUI initialization cannot transfer a claimed launch", { timeout: 5000 }, async (t) => {
  const f = await fixture(t), env = { [nativeProduct.launchEnv]: JSON.stringify(f.binding) };
  const start = createTui(env, { solid: f.solid });
  const outcomes = await Promise.allSettled([start(f.api), start(f.api)]);
  assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((value) => value.status === "rejected" && value.reason.code === "EEXIST").length, 1);
  await f.close();
  await assert.rejects(start(f.api), /disposed|aborted|EEXIST/i);
});

test("a stalled launch create is cancelled by plugin disposal; the TUI stays on home", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  f.stall();
  const started = createTui({ [nativeProduct.launchEnv]: JSON.stringify({ ...f.binding, create: true }) }, { solid: f.solid })(f.api);
  while (!f.creates.length) await new Promise((resolve) => setTimeout(resolve, 5));
  await f.close();
  await started;
  assert.deepEqual(f.api.route.current, { name: "home" });
});

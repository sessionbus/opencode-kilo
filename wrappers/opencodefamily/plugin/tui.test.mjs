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
  const events = new EventEmitter(), life = new AbortController(), disposals = new Set();
  const sockets = new Set(), hellos = [], updates = [], creates = [];
  let stallCreate = false;
  const server = net.createServer((stream) => {
    sockets.add(stream); stream.once("close", () => sockets.delete(stream));
    const wire = new Connection(stream, false, (request) => {
      if (request.method === "session.hello") { hellos.push(request.params); void wire.result(request, {}); }
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
      async get({ sessionID }) { return { response: { status: 200 }, data: { id: sessionID, title: "", directory: "/native" } }; },
      async status() { return { response: { status: 200 }, data: {} }; },
      async update(params) { updates.push(params); return { response: { status: 200 }, data: { id: params.sessionID, title: params.title, directory: "/native" } }; },
      async create(params, options) {
        creates.push(params);
        // A stalled request ends only through its abort signal, if it has one.
        if (stallCreate) await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
        return { response: { status: 200 }, data: { id: "ses_created", title: params.title || "", directory: "/native" } };
      },
    } },
  };
  const close = async () => { life.abort(); await Promise.all([...disposals].map((callback) => callback())); };
  t.after(async () => { await close(); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { directory, binding, api, solid, hellos, updates, creates, close, stall() { stallCreate = true; }, rootDisposed: () => disposedRoot, route(id) { api.route.current = { name: "session", params: { sessionID: id } }; effect(); } };
}

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

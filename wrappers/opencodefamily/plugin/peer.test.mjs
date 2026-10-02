// SPDX-License-Identifier: MIT
import { nativeProduct } from "./profile.mjs";

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Connection } from "@sessionbus/kit";
import { OwnedPeer } from "./peer.mjs";
import { createServer } from "./server.mjs";
import { InteractiveEndpoint } from "./endpoint.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const identity = { session_id: "ses_native", product: nativeProduct.product, groups: ["test"], info: {} };
async function fixture(t, handler) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oc-peer-"));
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const connection = new Connection(socket, false, (request) => {
      Promise.resolve(handler(connection, request)).catch((error) => connection.close(error));
    });
  });
  server.listen(path.join(directory, "bus"));
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { SESSIONBUS_SOCKET: path.join(directory, "bus") };
}
function own(t, env, options, deliver = async () => ({ disposition: "written" })) {
  const peer = new OwnedPeer(identity, deliver, env, options);
  t.after(() => peer.dispose());
  return peer;
}

test("spawn and resume retain response trace through actual kit and native tool", { timeout: 5000 }, async (t) => {
  let expected;
  const env = await fixture(t, (connection, request) => {
    if (request.method === "session.hello") return connection.result(request, {});
    assert.equal(request.method, "lane.spawn");
    // Raw wire response also proves the kit's inbound schema accepts trace.
    connection.stream.write(JSON.stringify({jsonrpc:"2.0", id:request.id, result:expected}) + "\n");
  });
  const peer = own(t, env);
  const endpointPath = path.join(path.dirname(env.SESSIONBUS_SOCKET), "actions.sock");
  const endpoint = new InteractiveEndpoint(endpointPath, (action, args) => peer.action(action, args));
  t.after(() => endpoint.dispose());
  await endpoint.ready();
  const hooks = await createServer({SESSIONBUS_LANE_SOCKET:endpointPath})();
  t.after(() => hooks.dispose());
  for (const trace of [undefined, "off", "events", "content"]) {
    for (const args of [{name:"child", product:"fixture-worker", open:{}}, {resume_session_id:"child@local"}]) {
      expected = {session_id:"child@local", policy:{persistent:false, auto_close_ms:60000, notify:true, ...(trace === undefined ? {} : {trace})}};
      const output = await hooks.tool.sessionbus.execute({action:"spawn", arguments:args}, {sessionID:identity.session_id, messageID:"msg_fixture_call"});
      assert.deepEqual(JSON.parse(output), expected);
    }
  }
  // The old kit closed its connection on the first response carrying trace.
  assert.deepEqual(await peer.action("spawn", {resume_session_id:"child@local"}), expected);
});

test("actual kit admits native identity before sole Caller action", { timeout: 5000 }, async (t) => {
  const hello = deferred(), release = deferred();
  const methods = [];
  const env = await fixture(t, async (connection, request) => {
    methods.push(request.method);
    if (request.method === "session.hello") {
      assert.equal(request.params.session_id, identity.session_id);
      hello.resolve();
      await release.promise;
      return connection.result(request, {});
    }
    return connection.result(request, { sessions: [] });
  });
  const peer = own(t, env);
  const action = peer.action("list", {});
  await hello.promise;
  assert.deepEqual(methods, ["session.hello"]);
  release.resolve();
  assert.deepEqual(await action, { sessions: [] });
  assert.deepEqual(methods, ["session.hello", "session.list"]);
  assert.ok(env.SESSIONBUS_SOCKET, "kit only consumes its copied environment");
});

test("actual kit failed attempt is not admission; scheduled reconnect can admit", { timeout: 5000 }, async (t) => {
  const retry = deferred(), hello = deferred();
  let scheduled, attempts = 0, cancelCount = 0;
  const env = await fixture(t, async (connection, request) => {
    hello.resolve();
    await connection.result(request, {});
  });
  const peer = own(t, env, {
    connect(socket) {
      attempts++;
      if (attempts === 1) {
        const stream = new net.Socket();
        queueMicrotask(() => stream.destroy(new Error("controlled initial wire failure")));
        return stream;
      }
      return net.createConnection(socket);
    },
    schedule(callback, delay) {
      assert.equal(delay, 2000, "kit reconnect interval preserved");
      scheduled = callback;
      retry.resolve();
      return () => cancelCount++;
    },
  });
  let admitted = false;
  const ready = peer.ready().then(() => { admitted = true; });
  await retry.promise;
  assert.equal(admitted, false);
  scheduled();
  await hello.promise;
  await ready;
  assert.equal(attempts, 2);
  await peer.dispose();
  assert.equal(cancelCount, 0, "completed timer removed");
});

test("actual kit permanent hello refusal settles readiness without timer or EOF", { timeout: 5000 }, async (t) => {
  let retries = 0;
  const env = await fixture(t, (connection, request) => connection.error(request, -32602));
  const peer = own(t, env, { schedule() { retries++; return () => {}; } });
  await assert.rejects(peer.ready(), /invalid_hello/);
  await peer.dispose();
  assert.equal(retries, 0);
});

test("deletion during held actual hello closes socket and cannot reappear", { timeout: 5000 }, async (t) => {
  const hello = deferred(), closed = deferred();
  let retry = 0;
  const env = await fixture(t, (connection) => {
    connection.stream.once("close", closed.resolve);
    hello.resolve();
  });
  const peer = own(t, env, { schedule() { retry++; return () => {}; } });
  const waiting = assert.rejects(peer.ready(), /deleted/);
  await hello.promise;
  await peer.dispose(new Error("native session deleted"));
  await waiting;
  await closed.promise;
  await assert.rejects(peer.action("list", {}), /deleted/);
  assert.equal(retry, 0);
});

test("deletion cancels owned reconnect timer and late callback cannot reconnect", { timeout: 5000 }, async (t) => {
  const timer = deferred();
  let callback, attempts = 0, canceled = 0;
  const peer = own(t, { SESSIONBUS_SOCKET: "/unused" }, {
    connect() { attempts++; throw new Error("pre-socket failure"); },
    schedule(call) { callback = call; timer.resolve(); return () => canceled++; },
  });
  await timer.promise;
  await peer.dispose();
  callback();
  assert.equal(attempts, 1);
  assert.equal(canceled, 1);
});

test("socket-close disposal cancels and joins held Caller work", { timeout: 5000 }, async (t) => {
  const list = deferred(), closed = deferred();
  const env = await fixture(t, async (connection, request) => {
    if (request.method === "session.hello") return connection.result(request, {});
    connection.stream.once("close", closed.resolve);
    list.resolve();
  });
  const peer = own(t, env);
  const action = assert.rejects(peer.action("list", {}), /native owner closed/);
  await list.promise;
  await peer.dispose();
  await action;
  await closed.promise;
});

test("reconnect gates new actions until the replacement hello is acknowledged", { timeout: 5000 }, async (t) => {
  const retry = deferred(), secondHello = deferred(), release = deferred();
  let first, scheduled, hellos = 0, lists = 0;
  const env = await fixture(t, async (connection, request) => {
    if (request.method === "session.hello") {
      if (++hellos === 1) first = connection;
      else { secondHello.resolve(); await release.promise; }
      return connection.result(request, {});
    }
    lists++;
    return connection.result(request, { sessions: [] });
  });
  const peer = own(t, env, { schedule(callback) { scheduled = callback; retry.resolve(); return () => {}; } });
  await peer.ready();
  first.close();
  await retry.promise;
  const action = peer.action("list", {});
  scheduled();
  await secondHello.promise;
  assert.equal(lists, 0);
  release.resolve();
  await action;
  assert.equal(lists, 1);
});

// As observed live (A6 diagnostic): after session.superseded the kit reports
// terminal while its reply write has not completed, so its closed is still
// pending. This socket holds the kit's replies once `held.on`, and releases
// them at the end so the kit finishes normally.
function holdingReplies(held) {
  return (socketPath) => {
    const socket = net.createConnection(socketPath);
    const write = socket.write.bind(socket);
    socket.write = (data, ...rest) => {
      if (!held.on || !String(data).includes('"result"')) return write(data, ...rest);
      held.parked.push(() => write(data, ...rest));
      return true;
    };
    return socket;
  };
}

test("a superseded peer rejects ready and actions at once while the kit's closed is still pending", { timeout: 5000 }, async (t) => {
  let wire;
  const env = await fixture(t, async (connection, request) => { wire = connection; await connection.result(request, request.method === "session.hello" ? {} : { sessions: [] }); });
  const held = { on: false, parked: [] };
  const peer = own(t, env, { connect: holdingReplies(held) });
  await peer.ready();
  held.on = true;
  const superseded = wire.call("session.superseded", {}).catch(() => {});
  while (!peer.terminal) await new Promise((resolve) => setTimeout(resolve, 5));
  const displaced = (error) => error.message === "Sessionbus: another kilo-peer launch took over this session (superseded); relaunch to use Sessionbus here"
    && error.code === -32012 && error.cause?.message === "superseded";
  await assert.rejects(peer.ready(), displaced);
  await assert.rejects(peer.action("list", {}), displaced);
  assert.equal(peer.signal.aborted, false, "the kit's closed is still pending");
  held.on = false;
  for (const release of held.parked.splice(0)) release();
  await superseded;
});

// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink, stat } from "node:fs/promises";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { waitForEndpoint, publishEndpoint } from "./readiness.mjs";

async function fixture(t) {
  const directory = await mkdtemp("/tmp/sb-ready-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("disposal removes its ready marker once; an old or failed publisher cannot remove the successor", async (t) => {
  const dir = await fixture(t);
  const remove = await publishEndpoint(dir);
  await assert.rejects(publishEndpoint(dir), { code: "EEXIST" });
  assert.equal((await stat(dir + "/actions.ready")).size, 0);
  await remove();
  await assert.rejects(stat(dir + "/actions.ready"), { code: "ENOENT" });
  const successor = await publishEndpoint(dir);
  await remove();
  assert.equal((await stat(dir + "/actions.ready")).size, 0);
  await successor();
});

function ownedWait(t, directory, lifetime = new AbortController()) {
  const ready = waitForEndpoint(directory, lifetime.signal);
  const settled = ready.then(() => {}, () => {});
  t.after(async () => {
    lifetime.abort();
    await settled;
  });
  return ready;
}

function readinessWorker(t, directory) {
  const worker = new Worker(new URL("./readiness-fixture.mjs", import.meta.url), { workerData: { directory } });
  const queue = [];
  let waiter, failure, exited = false;
  const fail = (error) => {
    failure = error;
    if (waiter) { waiter.reject(error); waiter = undefined; }
  };
  const exit = new Promise((resolve) => worker.once("exit", (code) => {
    exited = true;
    fail(new Error("readiness worker exited before expected result"));
    resolve(code);
  }));
  worker.on("error", fail);
  worker.on("message", (message) => {
    if (waiter) { const pending = waiter; waiter = undefined; pending.resolve(message); }
    else if (queue.length < 8) queue.push(message);
    else fail(new Error("unexpected readiness fixture message overflow"));
  });
  t.after(async () => {
    if (!exited) worker.postMessage("abort");
    await exit;
  });
  return {
    abort: () => worker.postMessage("abort"),
    exit,
    next: async (type) => {
      const message = queue.length ? queue.shift() : await new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        assert.equal(waiter, undefined);
        waiter = { resolve, reject };
      });
      assert.equal(message.type, type);
      return message;
    },
  };
}

test("publication reaches multiple Workers after negative checks with filesystem events unavailable", { timeout: 5000 }, async (t) => {
  const dir = await fixture(t);
  const a = readinessWorker(t, dir), b = readinessWorker(t, dir), cancelled = readinessWorker(t, dir);
  await Promise.all([a.next("absent"), b.next("absent"), cancelled.next("absent")]);
  cancelled.abort();
  assert.match((await cancelled.next("result")).error, /worker disposed/);
  assert.equal(await cancelled.exit, 0);
  await publishEndpoint(dir);
  for (const worker of [a, b]) {
    assert.equal((await worker.next("result")).endpoint, dir + "/actions.sock");
    assert.equal(await worker.exit, 0);
  }
});

test("a broadcast is only a wake; a missing marker remains pending and cancellation joins", { timeout: 5000 }, async (t) => {
  const dir = await fixture(t);
  const worker = readinessWorker(t, dir);
  await worker.next("absent");
  const publisher = new BroadcastChannel("sessionbus:endpoint:" + dir);
  try { publisher.postMessage({ ready: true }); }
  finally { publisher.close(); }
  await worker.next("absent");
  worker.abort();
  assert.match((await worker.next("result")).error, /worker disposed/);
  assert.equal(await worker.exit, 0);
  await publishEndpoint(dir);
});

for (const first of [true, false]) {
  test("empty ready marker " + (first ? "before" : "after") + " subscription", { timeout: 5000 }, async (t) => {
    const dir = await fixture(t);
    const lifetime = new AbortController();
    if (first) await publishEndpoint(dir);
    const ready = ownedWait(t, dir, lifetime);
    if (!first) await publishEndpoint(dir);
    assert.equal(await ready, dir + "/actions.sock");
    lifetime.abort();
  });
}

test("disposal cancels missing-marker wait and closes subscription", { timeout: 5000 }, async (t) => {
  const dir = await fixture(t);
  const lifetime = new AbortController();
  const ready = ownedWait(t, dir, lifetime);
  const rejected = assert.rejects(ready, /native disposed/);
  lifetime.abort(new Error("native disposed"));
  await rejected;
  await publishEndpoint(dir); // no resumed work/reconnect
});

for (const link of [false, true]) {
  test("reject " + (link ? "symlink" : "nonempty") + " marker", async (t) => {
    const dir = await fixture(t);
    if (link) {
      await writeFile(dir + "/other", "");
      await symlink("other", dir + "/actions.ready");
    } else await writeFile(dir + "/actions.ready", "stale data");
    await assert.rejects(ownedWait(t, dir), /invalid.*marker/);
  });
}

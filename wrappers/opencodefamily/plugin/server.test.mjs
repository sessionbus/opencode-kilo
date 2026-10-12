// SPDX-License-Identifier: MIT
import { nativeProduct } from "./profile.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createServer } from "./server.mjs";
import { interactiveActivation, claimInteractive } from "./activation.mjs";
import { InteractiveEndpoint } from "./endpoint.mjs";
import { publishEndpoint } from "./readiness.mjs";
import { SessionbusForwarder } from "./forward.mjs";

async function fixture(t) {
  const directory = await mkdtemp("/tmp/sb-server-");
  t.after(() => rm(directory, { recursive:true, force:true }));
  const binding = { directory, pid:process.ppid, socket:directory+"/bus.sock", name:"initial", groups:[] };
  return { directory, binding, environment: { [nativeProduct.launchEnv]: JSON.stringify(binding) } };
}
const native = { sessionID:"ses_actual", messageID:"msg_actual", abort:new AbortController().signal };

async function rejoinFixture(t) {
  const f = await fixture(t), clients = [];
  const hooks = await createServer(f.environment, { forwarder: (...args) => {
    const client = new SessionbusForwarder(...args); clients.push(client); return client;
  } })();
  t.after(() => hooks.dispose());
  const activate = async (action, input) => {
    const endpoint = new InteractiveEndpoint(f.directory + "/actions.sock", action, input);
    t.after(() => endpoint.dispose());
    await endpoint.ready();
    const remove = await publishEndpoint(f.directory);
    t.after(remove);
    return async () => {
      await remove(); await endpoint.dispose();
      await clients.at(-1).closed; // actual receiver-side close, no timing guess
    };
  };
  const call = (argumentsValue, context = native) => hooks.tool.sessionbus.execute({ action: "list", arguments: argumentsValue }, context);
  return { hooks, clients, activate, call };
}

test("after toggle-off tools fail now; concurrent next uses share one replacement and never replay the old call", { timeout: 5000 }, async (t) => {
  const f = await rejoinFixture(t), oldCalls = [], newCalls = [];
  let entered;
  const holding = new Promise((resolve) => { entered = resolve; });
  const off = await f.activate(async (_action, args, context) => {
    oldCalls.push(args);
    if (args.hold) {
      entered();
      await new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
    }
    return { id: context.sessionID };
  });
  await f.call({ initial: true });
  const pending = f.call({ hold: true });
  const rejected = assert.rejects(pending, /ended|closed/);
  await holding;
  await off(); await rejected;
  await assert.rejects(f.call({ whileOff: true }), /ENOENT/);
  assert.equal(f.clients.length, 1, "off-state calls create no reconnect waiter/client");
  const cancel = new AbortController(); cancel.abort(new Error("cancelled before reconnect"));
  await assert.rejects(f.call({}, { ...native, abort: cancel.signal }), /cancelled before reconnect/);
  assert.equal(f.clients.length, 1);
  await f.activate(async (_action, args, context) => { newCalls.push(args); return { id: context.sessionID, message: context.messageID }; });
  const replies = await Promise.all(["one", "two", "three"].map((id) => f.call({ id }, { ...native, sessionID: "ses_" + id, messageID: "msg_" + id })));
  assert.deepEqual(replies.map(JSON.parse), ["one", "two", "three"].map((id) => ({ id: "ses_" + id, message: "msg_" + id })));
  assert.equal(f.clients.length, 2, "one shared new connection after the old one actually ended");
  assert.deepEqual(newCalls, [{ id: "one" }, { id: "two" }, { id: "three" }]);
  assert.deepEqual(oldCalls, [{ initial: true }, { hold: true }]);
});

test("the first model-step hook after toggle-on reconnects rather than losing same-task input", { timeout: 5000 }, async (t) => {
  const f = await rejoinFixture(t);
  const off = await f.activate(async () => ({}));
  await f.call({}); await off();
  const requests = [];
  await f.activate(async () => ({}), async (params) => {
    requests.push(params);
    return { parts: [{ id: "prt_000000000002ABCDEFGHIJKLMN", sessionID: params.sessionID, messageID: params.messageID, type: "text", text: "change from peer after toggle" }] };
  });
  await f.hooks["chat.message"]({}, { message: { role: "user", sessionID: "ses_actual", id: "msg_task" } });
  const output = { messages: [{ info: { role: "user", sessionID: "ses_actual", id: "msg_task" }, parts: [{ id: "prt_000000000001ABCDEFGHIJKLMN", type: "text", text: "original task" }] }] };
  await f.hooks["experimental.chat.messages.transform"]({}, output);
  assert.equal(f.clients.length, 2);
  assert.deepEqual(requests, [{ sessionID: "ses_actual", messageID: "msg_task", after: "prt_000000000001ABCDEFGHIJKLMN" }]);
  assert.ok(output.messages[0].parts.some((part) => part.text === "change from peer after toggle"));
});

test("ordinary and inherited foreign-parent launches return no tool or owner", async (t) => {
  assert.deepEqual(await createServer({})(), {});
  const f = await fixture(t);
  f.binding.pid++;
  assert.deepEqual(await createServer({[nativeProduct.launchEnv]:JSON.stringify(f.binding)})(), {});
  assert.deepEqual(await stat(f.directory).then(async () => (await import("node:fs/promises")).readdir(f.directory)), []);
});

test("constructor returns before TUI readiness and native call metadata crosses resident endpoint", {timeout:5000}, async (t) => {
  const f = await fixture(t);
  const hooks = await createServer(f.environment)();
  t.after(() => hooks.dispose());
  assert.deepEqual(Object.keys(hooks.tool.sessionbus.args).sort(), ["action","arguments"]);
  const endpoint = new InteractiveEndpoint(f.directory+"/actions.sock", async (_action, _args, context) => ({id:context.sessionID, message:context.messageID}));
  t.after(() => endpoint.dispose());
  await endpoint.ready();
  await publishEndpoint(f.directory);
  const result = await hooks.tool.sessionbus.execute({action:"list",arguments:{}}, native);
  assert.deepEqual(JSON.parse(result), {id:"ses_actual",message:"msg_actual"});
});

test("cancelled startup calls release capacity; disposal joins missing-ready subscription", {timeout:5000}, async (t) => {
  const f = await fixture(t);
  const hooks = await createServer(f.environment)();
  for (let i=0;i<300;i++) {
    const cancel = new AbortController();
    const call = hooks.tool.sessionbus.execute({action:"list",arguments:{}}, {...native,abort:cancel.signal});
    const rejected = assert.rejects(call, /cancelled/);
    cancel.abort(new Error("cancelled"));
    await rejected;
  }
  const call = hooks.tool.sessionbus.execute({action:"list",arguments:{}}, native);
  const rejected = assert.rejects(call, /disposed/);
  await hooks.dispose();
  await rejected;
});

test("empty TUI claim admits exactly one overlapping owner and never transfers after failure", async (t) => {
  const f = await fixture(t);
  const launch = await interactiveActivation(f.environment);
  const claims = await Promise.allSettled([claimInteractive(launch), claimInteractive(launch)]);
  assert.equal(claims.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal((await stat(f.directory+"/owner.claim")).size, 0);
  await assert.rejects(claimInteractive(launch), {code:"EEXIST"});
});


test("managed Kilo shell projection overrides inherited topology without changing native auth", async (t) => {
  const f = await fixture(t);
  const hooks = await createServer(f.environment)();
  t.after(() => hooks.dispose());
  if (nativeProduct.product !== "kilo") {
    assert.equal(hooks["shell.env"], undefined);
    return;
  }
  const inherited = { ...process.env, KILO_NO_DAEMON:"1", KILO_PARENT_PID:"12345", KILO_SERVER_USERNAME:"native", KILO_SERVER_PASSWORD:"preserved" };
  const output = { env:{ UNRELATED:"kept" } };
  await hooks["shell.env"]({cwd:process.cwd()}, output);
  const actual = JSON.parse(execFileSync(process.execPath, ["-e", `console.log(JSON.stringify({daemon:!process.env.KILO_NO_DAEMON, parent:Number(process.env.KILO_PARENT_PID), username:process.env.KILO_SERVER_USERNAME, password:process.env.KILO_SERVER_PASSWORD, unrelated:process.env.UNRELATED}))`], { env:{...inherited, ...output.env}, encoding:"utf8" }));
  assert.deepEqual(actual, {daemon:true, parent:0, username:"native", password:"preserved", unrelated:"kept"});
  // Native itself removes auth from model shells; the plugin must not alter
  // the owning native server's auth or optional parent-watchdog environment.
  assert.equal(inherited.KILO_PARENT_PID, "12345");
  assert.equal(inherited.KILO_NO_DAEMON, "1");
});

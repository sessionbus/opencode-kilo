// SPDX-License-Identifier: MIT
import { nativeProduct } from "./profile.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createServer } from "./server.mjs";
import { orderedPartID } from "./native-input.mjs";
import { interactiveActivation, claimInteractive } from "./activation.mjs";
import { InteractiveEndpoint } from "./endpoint.mjs";
import { publishEndpoint } from "./readiness.mjs";

async function fixture(t) {
  const directory = await mkdtemp("/tmp/sb-server-");
  t.after(() => rm(directory, { recursive:true, force:true }));
  const binding = { directory, pid:process.ppid, socket:directory+"/bus.sock", name:"initial", groups:[] };
  return { directory, binding, environment: { [nativeProduct.launchEnv]: JSON.stringify(binding) } };
}
const native = { sessionID:"ses_actual", messageID:"msg_actual", abort:new AbortController().signal };

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

test("resident hook uses a private method and reciprocal tool work returns before the next step", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); let sent = false, attempts = 0;
  const endpoint = new InteractiveEndpoint(f.directory+"/actions.sock", async (action) => { assert.equal(action, "send"); sent = true; return { deliveries: [] }; }, async (request) => {
    if (request.operation === "bind") return { token: "exact_generation" };
    assert.equal(sent, true, "tool action was waiting for a reciprocal transform");
    attempts++;
    return { parts: [{ id: orderedPartID(request.after), sessionID: request.sessionID, messageID: request.messageID, type: "text", text: "bus message identity" }] };
  });
  t.after(() => endpoint.dispose()); await endpoint.ready(); await publishEndpoint(f.directory);
  const hooks = await createServer(f.environment)(); t.after(() => hooks.dispose());
  const message = { info: { id: "msg_actual", role: "user", sessionID: "ses_actual", time: { created: 100 } }, parts: [{ id: "prt_authored", sessionID: "ses_actual", messageID: "msg_actual", type: "text", text: "native authored text" }] };
  await hooks["chat.message"]({ sessionID: "ses_actual" }, { message: message.info });
  await hooks.tool.sessionbus.execute({ action: "send", arguments: { target: "controller", message: "reciprocal" } }, native);
  await hooks["experimental.chat.messages.transform"]({}, { messages: [message] });
  assert.equal(attempts, 1); assert.equal(message.parts[0].text, "native authored text"); assert.ok(message.parts[1].id > message.parts[0].id);
});

test("private unsupported operation has no consumer effects; End cancels a held hook", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); let calls = 0, entered, joined = false;
  const pending = new Promise((resolve) => { entered = resolve; });
  const endpoint = new InteractiveEndpoint(f.directory+"/actions.sock", async () => ({}), async (request, signal) => {
    calls++; assert.equal(request.operation, "bind"); entered(signal);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    joined = true; throw signal.reason;
  });
  t.after(() => endpoint.dispose()); await endpoint.ready(); await publishEndpoint(f.directory);
  assert.throws(() => endpoint.nativeInput({ operation: "unknown" }, new AbortController().signal), (error) => error.code === -32601);
  assert.equal(calls, 0);
  const hooks = await createServer(f.environment)(); t.after(() => hooks.dispose());
  const bind = hooks["chat.message"]({ sessionID: "ses_actual" }, { message: { id: "msg_actual", role: "user", sessionID: "ses_actual", time: { created: 100 } } });
  const failed = assert.rejects(bind, /disposed/); const signal = await pending;
  await hooks.dispose(); await failed; await endpoint.dispose();
  assert.equal(signal.aborted, true); assert.equal(joined, true); assert.equal(calls, 1);
});

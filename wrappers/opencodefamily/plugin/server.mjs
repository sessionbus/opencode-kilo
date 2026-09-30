// SPDX-License-Identifier: MIT
import { nativeProduct } from "./profile.mjs";
import path from "node:path";
import declaration from "./sessionbus-tool.json" with { type: "json" };
import { launchEnvironment, interactiveActivation } from "./activation.mjs";
import { ReadyGate } from "./gate.mjs";
import { waitForEndpoint } from "./readiness.mjs";
import { SessionbusForwarder, bridgeLimits } from "./forward.mjs";
import { inputHooks } from "./native-input.mjs";

export function createServer(environment = launchEnvironment) {
  let instances = 0, calls = 0;
  return async function server() {
    const lane = environment.SESSIONBUS_LANE_SOCKET;
    if (lane && environment[nativeProduct.launchEnv]) throw new Error(`${nativeProduct.label} lane and interactive activation conflict`);
    if (lane && (typeof lane !== "string" || !path.isAbsolute(lane))) throw new Error("invalid native lane endpoint");
    const launch = lane ? null : await interactiveActivation(environment);
    if (!lane && !launch) return {};
    if (instances >= bridgeLimits.connections) throw new Error("Sessionbus native server instance limit reached");
    instances++;
    const lifetime = new AbortController();
    const ready = new ReadyGate();
    let forward, disposing;
    const ownedCalls = new Set();
    const starting = (async () => {
      const endpoint = lane || await waitForEndpoint(launch.directory, lifetime.signal);
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      forward = new SessionbusForwarder(endpoint, lifetime.signal);
      await forward.ready(lifetime.signal);
      ready.settle(undefined, forward);
    })().catch((error) => ready.settle(error));
    const input = inputHooks((parameters, signal) => {
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      if (calls >= bridgeLimits.work) throw new Error("Sessionbus native hook work limit reached");
      calls++;
      const operation = ready.wait(signal).then((client) => client.nativeInput(parameters, signal))
        .finally(() => { calls--; ownedCalls.delete(operation); });
      ownedCalls.add(operation);
      return operation;
    }, lifetime.signal);
    // Constructor never waits for TUI listen/initialize or calls native HTTP:
    // quiet resume validation may need this server before TUI plugins start.
    return {
      "chat.message": input["chat.message"],
      "experimental.chat.messages.transform": input["experimental.chat.messages.transform"],
      // Native shell paths merge process.env before this projection (or use
      // extendEnv). Empty strings override inherited values: daemon discovery
      // becomes enabled and the optional configured-parent watchdog is inactive.
      // Deleting keys from the initially empty output.env would not do that.
      ...(nativeProduct.product === "kilo" ? {
        "shell.env": async (_input, output) => {
          output.env.KILO_NO_DAEMON = "";
          output.env.KILO_PARENT_PID = "";
        },
      } : {}),
      tool: {
        sessionbus: {
          description: declaration.description,
          args: declaration.inputSchema.properties,
          execute: (input, native) => {
            if (lifetime.signal.aborted) throw lifetime.signal.reason;
            if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, "action") || !Object.hasOwn(input, "arguments")) throw new Error("expected Sessionbus action and arguments");
            if (calls >= bridgeLimits.work) throw new Error("Sessionbus native tool work limit reached");
            calls++;
            const operation = (async () => {
              const abort = native?.abort ? AbortSignal.any([native.abort, lifetime.signal]) : lifetime.signal;
              const client = await ready.wait(abort);
              return JSON.stringify(await client.action(input.action, input.arguments, { sessionID: native?.sessionID, messageID: native?.messageID, abort }));
            })().finally(() => { calls--; ownedCalls.delete(operation); });
            ownedCalls.add(operation);
            return operation;
          },
        },
      },
      dispose: () => {
        if (disposing) return disposing;
        lifetime.abort(new Error("native server plugin disposed"));
        input.clear();
        ready.settle(lifetime.signal.reason);
        disposing = (async () => {
          await starting;
          await forward?.dispose();
          await Promise.allSettled([...ownedCalls]);
          instances--;
        })();
        return disposing;
      },
    };
  };
}

export default { id: nativeProduct.packageName, server: createServer() };

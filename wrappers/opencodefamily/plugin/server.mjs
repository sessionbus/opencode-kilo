// SPDX-License-Identifier: MIT
import { nativeProduct } from "./profile.mjs";
import path from "node:path";
import declaration from "./sessionbus-tool.json" with { type: "json" };
import { launchEnvironment, interactiveActivation } from "./activation.mjs";
import { ReadyGate } from "./gate.mjs";
import { waitForEndpoint } from "./readiness.mjs";
import { SessionbusForwarder, bridgeLimits } from "./forward.mjs";
import { nextPartID, placeHandoffs } from "./delivery.mjs";

export function createServer(environment = launchEnvironment) {
  let instances = 0, calls = 0;
  return async function server(input) {
    const lane = environment.SESSIONBUS_LANE_SOCKET;
    if (lane && environment[nativeProduct.launchEnv]) throw new Error(`${nativeProduct.label} lane and interactive activation conflict`);
    if (lane && (typeof lane !== "string" || !path.isAbsolute(lane))) throw new Error("invalid native lane endpoint");
    const launch = lane ? null : await interactiveActivation(environment);
    if (!lane && !launch) return {};
    if (instances >= bridgeLimits.connections) throw new Error("Sessionbus native server instance limit reached");
    instances++;
    const lifetime = new AbortController();
    const ready = new ReadyGate();
    let forward, connected, disposing;
    const ownedCalls = new Set();
    const starting = (async () => {
      const endpoint = lane || await waitForEndpoint(launch.directory, lifetime.signal);
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      forward = new SessionbusForwarder(endpoint, lifetime.signal);
      await forward.ready(lifetime.signal);
      connected = forward;
      ready.settle(undefined, forward);
    })().catch((error) => ready.settle(error));
    // Busy handoff. chat.message records each session's newest prompt. Before
    // each model call the transform asks the owner (the TUI, or a lane's Go
    // worker) to append queued input to the user message native is answering:
    // the last user at or after that prompt (plugins may add synthetic users
    // after it). A call whose messages lack the newest prompt (compaction passes
    // an older history head) is not a target. It never waits for readiness and
    // never throws into native: input not handed off stays with the owner for a
    // later step, the interactive idle wake or the lane Run's last message.
    const latest = new Map();
    // A lane's owner answers through the pinned hidden hook tool, which writes
    // the queued input as the native part named here and returns no data; this
    // call then reads that one part back.
    const laneInput = async (sessionID, messageID, after) => {
      const partID = nextPartID(after);
      if (!partID || !input?.client) return undefined;
      try {
        await connected.laneInput({ session_id: sessionID, message_id: messageID, part_id: partID }, lifetime.signal);
      } catch (error) {
        if (error?.value?.error === "no queued input") return undefined;
        throw error;
      }
      const read = await input.client.session.message({ path: { id: sessionID, messageID } });
      return { parts: Array.isArray(read?.data?.parts) ? read.data.parts.filter((part) => part?.id === partID) : [] };
    };
    const busyHooks = {
      "chat.message": async (_input, output) => {
        const info = output?.message;
        if (info?.role === "user" && typeof info.sessionID === "string" && typeof info.id === "string") latest.set(info.sessionID, info.id);
      },
      event: async ({ event }) => {
        if (event?.type === "session.deleted") latest.delete(event.properties?.info?.id);
      },
      "experimental.chat.messages.transform": async (input, output) => {
        await handOff(input, output);
        // Only a call that carries the newest prompt; a head without it (such as a
        // compaction head) is left as it is.
        const messages = Array.isArray(output?.messages) ? output.messages : [];
        if (!messages.some((message) => message?.info?.role === "user" && latest.get(message.info.sessionID) === message.info.id)) return;
        try { placeHandoffs(messages); } catch (error) { console.error(`sessionbus: ${error?.message || error}`); }
      },
    };
    async function handOff(_input, output) {
        try {
          const messages = Array.isArray(output?.messages) ? output.messages : [];
          const prompt = messages.findLastIndex((message) => message?.info?.role === "user" && latest.get(message.info.sessionID) === message.info.id);
          const user = prompt < 0 ? undefined : messages.findLast((message, index) => index >= prompt && message?.info?.role === "user");
          const sessionID = user?.info?.sessionID;
          if (!user || !Array.isArray(user.parts) || sessionID !== messages[prompt].info.sessionID) return;
          if (!connected || lifetime.signal.aborted || calls >= bridgeLimits.work) return;
          let after = "";
          for (const part of user.parts) if (typeof part?.id === "string" && part.id > after) after = part.id;
          calls++;
          const operation = (lane ? laneInput(sessionID, user.info.id, after) : connected.nativeInput({ sessionID, messageID: user.info.id, after }, lifetime.signal))
            .finally(() => { calls--; ownedCalls.delete(operation); });
          ownedCalls.add(operation);
          const reply = await operation;
          for (const part of Array.isArray(reply?.parts) ? reply.parts : []) {
            if (part?.type === "text" && typeof part.text === "string" && part.sessionID === sessionID && part.messageID === user.info.id && typeof part.id === "string" && part.id > after) user.parts.push(part);
          }
        } catch (error) { console.error(`sessionbus: ${error?.message || error}`); }
    }
    // Constructor never waits for TUI listen/initialize or calls native HTTP:
    // quiet resume validation may need this server before TUI plugins start.
    return {
      ...busyHooks,
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

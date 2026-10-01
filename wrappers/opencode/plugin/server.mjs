// SPDX-License-Identifier: MIT
import { validate } from "@sessionbus/kit";
import declaration from "./sessionbus-tool.json" with { type: "json" };
import { contract } from "./contract.mjs";
import { renderDelivery } from "./delivery.mjs";
import { OwnedPeer } from "./peer.mjs";

// Sessionbus attachment for OpenCode v2 sessions a managed TUI activated. The
// Peers belong to this location's plugin instance: when native unloads an idle
// directory its cleanup closes them, and a TUI still showing the session
// activates it again. Delivery is one native steer prompt: native admits it to
// the session inbox, wakes an idle session, and hands it to a busy one at its
// next model step.
export function createServer(dependencies = {}) {
  const connect = dependencies.peer || ((identity, deliver, env) => new OwnedPeer(identity, deliver, env));
  return async function setup(ctx) {
    const peers = new Map();
    await ctx.rpc.register(contract, {
      activate: async (input) => {
        // Idempotent: the TUI activates again after reconnects and unloads.
        if (peers.has(input.sessionID)) return {};
        const session = await ctx.session.get({ sessionID: input.sessionID });
        const identity = hello(input, session, ctx.location.directory);
        const peer = connect(identity, async (_signal, message) => {
          try {
            await ctx.session.prompt({ sessionID: input.sessionID, text: renderDelivery(message), delivery: "steer" });
            return { disposition: "injected" };
          } catch (error) {
            return { disposition: "rejected", reason: String(error?.message || error) };
          }
        }, { SESSIONBUS_SOCKET: input.socket });
        peers.set(input.sessionID, peer);
        peer.signal.addEventListener("abort", () => {
          if (peers.get(input.sessionID) === peer) peers.delete(input.sessionID);
        }, { once: true });
        return {};
      },
    });
    await ctx.tool.transform((tools) => tools.add({
      name: "sessionbus",
      description: declaration.description,
      input: declaration.inputSchema,
      options: { codemode: false },
      execute: async (input, context) => {
        const peer = peers.get(context.sessionID);
        if (!peer) throw new Error("Sessionbus is not active for this OpenCode session");
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, "action") || !Object.hasOwn(input, "arguments")) throw new Error("expected Sessionbus action and arguments");
        return { content: JSON.stringify(await peer.action(input.action, input.arguments, context.signal)) };
      },
    }));
    // Only activated sessions see the tool.
    await ctx.session.hook("context", (request) => {
      if (!peers.has(request.sessionID)) delete request.tools.sessionbus;
    });
    // Closes only this instance's Peers; a newer instance's hello supersedes.
    return async () => { await Promise.allSettled([...peers.values()].map((peer) => peer.dispose())); };
  };
}

export default { id: "sessionbus", setup: createServer() };

function hello(input, session, directory) {
  const identity = { product: "opencode-peer", session_id: input.sessionID, groups: input.groups, info: { cwd: directory } };
  const name = input.name || session?.title;
  if (name && validate("SessionHelloRequest", { protocol: 1, ...identity, name })) return { ...identity, name };
  if (!validate("SessionHelloRequest", { protocol: 1, ...identity })) throw new Error("invalid Sessionbus identity for this OpenCode session");
  return identity;
}

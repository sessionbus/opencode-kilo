// SPDX-License-Identifier: MIT
import { ProtocolError, validate } from "@sessionbus/kit";
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
    // sessionID -> { peer, socket, groups } for this instance only.
    const peers = new Map();
    const report = (error) => console.error(`sessionbus: ${error?.message || error}`);
    const attach = async (sessionID, binding) => {
      const session = await ctx.session.get({ sessionID });
      // Native does not serialize handlers: a concurrent attach may have won.
      if (peers.has(sessionID)) return;
      const identity = hello(sessionID, binding, session, ctx.location.directory);
      const peer = connect(identity, async (_signal, message) => {
        try {
          await ctx.session.prompt({ sessionID, text: renderDelivery(message), delivery: "steer" });
        } catch (error) {
          // Native may already have admitted it: an uncertain outcome, never a refusal.
          throw new ProtocolError({ code: -32603, message: "internal", data: String(error?.message || error) });
        }
        return { disposition: "injected" };
      }, { SESSIONBUS_SOCKET: binding.socket });
      peers.set(sessionID, { peer, socket: binding.socket, groups: binding.groups });
      peer.signal.addEventListener("abort", () => {
        if (peers.get(sessionID)?.peer === peer) peers.delete(sessionID);
      }, { once: true });
    };
    await ctx.rpc.register(contract, {
      activate: async (input) => {
        // Idempotent: the TUI activates again after reconnects and unloads.
        if (!peers.has(input.sessionID)) await attach(input.sessionID, input);
        return {};
      },
    });
    await ctx.tool.transform((tools) => tools.add({
      name: "sessionbus",
      description: declaration.description,
      input: declaration.inputSchema,
      options: { codemode: false },
      execute: async (input, context) => {
        const entry = peers.get(context.sessionID);
        if (!entry) throw new Error("Sessionbus is not active for this OpenCode session");
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, "action") || !Object.hasOwn(input, "arguments")) throw new Error("expected Sessionbus action and arguments");
        return { content: JSON.stringify(await entry.peer.action(input.action, input.arguments, context.signal)) };
      },
    }));
    // Only attached sessions see the tool. A native Task child of an attached
    // session attaches at its first model request, under its own ID and title
    // with the parent's groups: a new child, and an existing one native
    // continues (subagent sessionID reuse creates no session).
    await ctx.session.hook("context", async (request) => {
      if (peers.has(request.sessionID)) return;
      if (peers.size) {
        try {
          const parent = peers.get((await ctx.session.get({ sessionID: request.sessionID }))?.parentID);
          if (parent) await attach(request.sessionID, { socket: parent.socket, groups: parent.groups });
          if (peers.has(request.sessionID)) return;
        } catch (error) {
          report(error);
        }
      }
      delete request.tools.sessionbus;
    });
    // One native event loop: a deleted session leaves the bus; a renamed one
    // says hello again under its new title (a title outside the bus name
    // grammar keeps the old one).
    const events = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: events.signal })) {
        const data = event?.data;
        if (event?.type === "session.deleted") void peers.get(data?.sessionID)?.peer.dispose();
        const renamed = event?.type === "session.renamed" ? peers.get(data?.sessionID) : undefined;
        if (renamed && validate("SessionHelloRequest", { protocol: 1, product: "opencode-peer", session_id: data.sessionID, groups: [], info: { cwd: ctx.location.directory }, name: data.title })) {
          void renamed.peer.rehello(data.title, { cwd: ctx.location.directory }).catch(report);
        }
      }
    })().catch((error) => { if (!events.signal.aborted) report(error); });
    // Closes only this instance's Peers; a newer instance's hello supersedes.
    return async () => {
      events.abort();
      await Promise.allSettled([...peers.values()].map((entry) => entry.peer.dispose()));
    };
  };
}

export default { id: "sessionbus", setup: createServer() };

function hello(sessionID, binding, session, directory) {
  const identity = { product: "opencode-peer", session_id: sessionID, groups: binding.groups, info: { cwd: directory } };
  const name = binding.name || session?.title;
  if (name && validate("SessionHelloRequest", { protocol: 1, ...identity, name })) return { ...identity, name };
  if (!validate("SessionHelloRequest", { protocol: 1, ...identity })) throw new Error("invalid Sessionbus identity for this OpenCode session");
  return identity;
}

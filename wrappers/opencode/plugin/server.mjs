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
//
// Native sub-agent (Task) sessions are never peers of their own (owner,
// 2026-10-01): where native lets one use the tool, it acts as the activated
// session it descends from, best effort. A helper that needs its own identity
// and guaranteed communications is a lane.
//
// A session a managed TUI activated always keeps the Sessionbus tool (owner,
// 2026-09-19: no communications opt-out): one session permission rule allows
// only this tool. Native evaluates agent rules, then session rules, and the
// last match wins, so the rule overrides a config or agent deny; every other
// rule is kept. Sub-agents get no such rule.
const grant = { action: "sessionbus", resource: "*", effect: "allow" };

// The daemon accepts only the ASCII space among space separators in a name
// (Go unicode.IsPrint); the kit schema accepts all of them, and a hello the
// daemon refuses ends the Peer. Such a title keeps the old bus name, like any
// other title outside the grammar.
const daemonName = (name) => typeof name === "string" && !/\p{Zs}/u.test(name.replaceAll(" ", ""));

export function createServer(dependencies = {}) {
  const connect = dependencies.peer || ((identity, deliver, env) => new OwnedPeer(identity, deliver, env));
  return async function setup(ctx) {
    // sessionID -> { peer } for this instance only.
    const peers = new Map();
    const report = (error) => console.error(`sessionbus: ${error?.message || error}`);
    // The activated session a sub-agent descends from, by native ancestry;
    // nothing is read while no session is attached.
    const owner = async (sessionID) => {
      for (let id = sessionID, depth = 0; id && peers.size && depth < 16; depth++) {
        const entry = peers.get(id);
        if (entry) return entry;
        id = (await ctx.session.get({ sessionID: id }).catch(report))?.parentID;
      }
      return undefined;
    };
    const attach = async (sessionID, binding) => {
      const session = await ctx.session.get({ sessionID });
      // A sub-agent shown by a managed TUI still speaks as its ancestor.
      if (session?.parentID) return;
      const rules = session?.permissions ?? [];
      const last = rules.at(-1);
      if (last?.action !== grant.action || last.resource !== grant.resource || last.effect !== grant.effect) {
        // Without it an activated session would be on the bus without its tool.
        await ctx.session.update({ sessionID, permissions: [...rules, grant] });
      }
      // Native does not serialize handlers: a concurrent attach may have won
      // during the awaits above.
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
      peers.set(sessionID, { peer });
      peer.signal.addEventListener("abort", () => {
        if (peers.get(sessionID)?.peer === peer) peers.delete(sessionID);
      }, { once: true });
    };
    await ctx.rpc.register(contract, {
      activate: async (input) => {
        // Idempotent: the TUI activates again after reconnects and unloads.
        await attach(input.sessionID, input);
        return {};
      },
    });
    await ctx.tool.transform((tools) => tools.add({
      name: "sessionbus",
      description: declaration.description,
      input: declaration.inputSchema,
      options: { codemode: false },
      execute: async (input, context) => {
        const entry = await owner(context.sessionID);
        if (!entry) throw new Error("Sessionbus is not active for this OpenCode session");
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, "action") || !Object.hasOwn(input, "arguments")) throw new Error("expected Sessionbus action and arguments");
        return { content: JSON.stringify(await entry.peer.action(input.action, input.arguments, context.signal)) };
      },
    }));
    // Only attached sessions and their sub-agents see the tool.
    await ctx.session.hook("context", async (request) => {
      if (!(await owner(request.sessionID))) delete request.tools.sessionbus;
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
        if (renamed && daemonName(data.title) && validate("SessionHelloRequest", { protocol: 1, product: "opencode-peer", session_id: data.sessionID, groups: [], info: { cwd: ctx.location.directory }, name: data.title })) {
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
  if (name && daemonName(name) && validate("SessionHelloRequest", { protocol: 1, ...identity, name })) return { ...identity, name };
  if (!validate("SessionHelloRequest", { protocol: 1, ...identity })) throw new Error("invalid Sessionbus identity for this OpenCode session");
  return identity;
}

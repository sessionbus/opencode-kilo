// SPDX-License-Identifier: MIT
import { ProtocolError, validate } from "@sessionbus/kit";
import declaration from "./sessionbus-tool.json" with { type: "json" };
import { contract } from "./contract.mjs";
import { renderDelivery } from "./delivery.mjs";
import { SessionbusForwarder } from "./forward.mjs";
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
// A Sessionbus lane worker drives its session through this shared service and
// binds the session's tool to the worker's own private endpoint: the lane
// speaks as the worker's bus identity, so no Peer is created here. One holder
// per session, the first keeps it: a managed TUI cannot activate a lane's
// session, nor a lane bind a session a TUI activated. The binding lives as long
// as the worker's connection.
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
  const forwarder = dependencies.forwarder || ((socket, lifetime) => new SessionbusForwarder(socket, lifetime));
  // How long activation waits for the bus to admit the session: a few of the
  // kit's 2 s reconnect intervals. The Peer keeps reconnecting after that.
  const admissionWait = dependencies.admissionWait ?? 10_000;
  return async function setup(ctx) {
    // sessionID -> { peer } (activated by a managed TUI) or { lane, forward }
    // (bound by a lane worker), for this instance only.
    const peers = new Map();
    const lifetime = new AbortController();
    const report = (error) => console.error(`sessionbus: ${error?.message || error}`);
    const release = (entry) => (entry.forward ?? entry.peer).dispose();
    const conflict = (context, entry) => context.error("sessionbus.conflict", entry.forward ? "a Sessionbus lane holds this session" : "a managed OpenCode TUI holds this session on Sessionbus", {});
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
      activate: async (input, context) => {
        if (peers.get(input.sessionID)?.forward) return conflict(context, peers.get(input.sessionID));
        // Idempotent: the TUI activates again after reconnects and unloads.
        await attach(input.sessionID, input);
        // Activation reports success only once the bus has admitted the
        // session. Not yet admitted is the declared transient error: the TUI
        // keeps the session for the next native event while the Peer keeps
        // connecting. A refused Peer reports its refusal; a cancelled RPC ends
        // only this wait.
        const entry = peers.get(input.sessionID);
        if (entry?.forward) return conflict(context, entry);
        if (entry) {
          try {
            await entry.peer.ready(AbortSignal.any([context.signal, AbortSignal.timeout(admissionWait)]));
          } catch (error) {
            if (error?.name === "TimeoutError") return context.error("sessionbus.not_admitted", "the bus has not admitted this session yet; still connecting", {});
            throw error;
          }
        }
        return {};
      },
      lane: async ({ sessionID, socket }, context) => {
        const held = peers.get(sessionID);
        // Idempotent for the same live binding: the worker binds before every Run.
        if (held?.lane === socket) return held.forward.ready(context.signal).then(() => ({}));
        if (held) return conflict(context, held);
        if (!socket.startsWith("/")) throw new Error("Sessionbus lane endpoint must be an absolute path");
        const session = await ctx.session.get({ sessionID });
        if (session?.parentID) throw new Error("a native sub-agent session is not a Sessionbus lane");
        // Native does not serialize handlers: another holder may have won during the read.
        if (peers.has(sessionID)) return conflict(context, peers.get(sessionID));
        const entry = { lane: socket, forward: forwarder(socket, lifetime.signal) };
        peers.set(sessionID, entry);
        // Only this binding's end releases the session; a later holder stays.
        void entry.forward.closed.then(() => {
          if (peers.get(sessionID) === entry) peers.delete(sessionID);
        });
        try {
          await entry.forward.ready(AbortSignal.any([context.signal, AbortSignal.timeout(admissionWait)]));
        } catch (error) {
          void entry.forward.dispose();
          throw error;
        }
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
        const result = entry.forward
          ? await entry.forward.action(input.action, input.arguments, { sessionID: context.sessionID, messageID: context.messageID, abort: context.signal })
          : await entry.peer.action(input.action, input.arguments, context.signal);
        return { content: JSON.stringify(result) };
      },
    }));
    // Only attached sessions and their sub-agents see the tool.
    await ctx.session.hook("context", async (request) => {
      if (!(await owner(request.sessionID))) delete request.tools.sessionbus;
    });
    // One native event loop: a deleted session leaves the bus; a renamed
    // activated one says hello again under its new title (a title outside the
    // bus name grammar keeps the old one). A lane's name is the worker's.
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: lifetime.signal })) {
        const data = event?.data;
        const entry = peers.get(data?.sessionID);
        if (event?.type === "session.deleted" && entry) void release(entry);
        const renamed = event?.type === "session.renamed" && entry?.peer ? entry : undefined;
        if (renamed && daemonName(data.title) && validate("SessionHelloRequest", { protocol: 1, product: "opencode-peer", session_id: data.sessionID, groups: [], info: { cwd: ctx.location.directory }, name: data.title })) {
          void renamed.peer.rehello(data.title, { cwd: ctx.location.directory }).catch(report);
        }
      }
    })().catch((error) => { if (!lifetime.signal.aborted) report(error); });
    // Closes only this instance's Peers and lane bindings; a newer instance's
    // hello supersedes, and a lane binds its session again before its next Run.
    return async () => {
      lifetime.abort();
      await Promise.allSettled([...peers.values()].map(release));
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

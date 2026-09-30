// SPDX-License-Identifier: MIT
import { randomBytes } from "node:crypto";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export function nativeID(value, prefix) {
  return typeof value === "string" && value.startsWith(prefix) && Buffer.byteLength(value) <= 256 && !/[\s\0]/u.test(value);
}
export function userTuple(info) {
  if (!object(info) || info.role !== "user" || !nativeID(info.sessionID, "ses_") || !nativeID(info.id, "msg_") || !Number.isSafeInteger(info.time?.created) || info.time.created < 0) throw new Error("native input user identity is malformed");
  return Object.freeze({ sessionID: info.sessionID, messageID: info.id, created: info.time.created });
}
export function compareUsers(a, b) {
  return a.created === b.created ? (a.messageID > b.messageID ? 1 : a.messageID < b.messageID ? -1 : 0) : a.created - b.created;
}
export function partFloor(value) {
  // This is the adapter's private-metadata bound, not a native PartID limit.
  if (typeof value !== "string" || !value.startsWith("prt_") || value.length > 256 || !/^[\x21-\x7e]+$/u.test(value)) throw new Error("native input part ordering metadata is unsupported");
  return value;
}
export function orderedPartID(floor, entropy = randomBytes) {
  partFloor(floor);
  const checked = (id) => { if (partFloor(id) <= floor) throw new Error("native input part ID did not advance"); return id; };
  if (floor === "prt_" || /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/u.test(floor) && floor.slice(4, 16) !== "ffffffffffff") {
    const head = floor === "prt_" ? 0n : BigInt(`0x${floor.slice(4, 16)}`) + 1n;
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    return checked(`prt_${head.toString(16).padStart(12, "0")}${[...entropy(14)].map((byte) => alphabet[byte % 62]).join("")}`);
  }
  // SQLite BINARY orders ASCII bytes. Increase the first differing byte and
  // retain a 128-bit random suffix; never grow an unbounded suffix chain.
  for (let i = Math.min(floor.length - 1, 223); i >= 4; i--) {
    if (floor.charCodeAt(i) < 126) return checked(floor.slice(0, i) + String.fromCharCode(floor.charCodeAt(i) + 1) + entropy(16).toString("hex"));
  }
  if (floor.length + 32 <= 256) return checked(floor + entropy(16).toString("hex"));
  throw new Error("no acceptable part ID successor within the adapter ordering bound");
}
export function currentUser(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error("native input context is empty or malformed");
  let selected, tuple, sessionID;
  for (const message of messages) {
    if (!object(message?.info) || !Array.isArray(message.parts) || !nativeID(message.info.sessionID, "ses_")) throw new Error("native input context is malformed");
    sessionID ??= message.info.sessionID;
    if (sessionID !== message.info.sessionID) throw new Error("native input context mixes sessions");
    if (message.info.role !== "user") continue;
    const candidate = userTuple(message.info);
    // Native compaction projects model order independently of DB chronology.
    // Both installed engines order equal-created DB users by their native ID.
    if (!tuple || compareUsers(candidate, tuple) > 0) { selected = message; tuple = candidate; }
  }
  if (!selected) throw new Error("native input context has no current user");
  let after = "prt_";
  for (const part of selected.parts) {
    const id = partFloor(part?.id);
    if (part.sessionID !== tuple.sessionID || part.messageID !== tuple.messageID) throw new Error("native input part mixes parent identities");
    if (id > after) after = id;
  }
  return Object.freeze({ message: selected, tuple, after });
}
export function inputRequest(value) {
  if (!object(value) || !["bind", "step"].includes(value.operation) || Object.keys(value).length !== (value.operation === "bind" ? 4 : 6) || Object.keys(value).some((key) => !["operation", "sessionID", "messageID", "created", ...(value.operation === "step" ? ["token", "after"] : [])].includes(key))) throw new Error("invalid native input request");
  const tuple = userTuple({ role: "user", id: value.messageID, sessionID: value.sessionID, time: { created: value.created } });
  if (value.operation === "step" && (typeof value.token !== "string" || !value.token.length || Buffer.byteLength(value.token) > 512)) throw new Error("invalid native input binding");
  return { ...tuple, operation: value.operation, ...(value.operation === "step" ? { token: value.token, after: partFloor(value.after) } : {}) };
}

// The native server retains bindings only. The endpoint remains the sole FIFO
// owner, and uses the binding to reject old hooks across owner/Run replacement.
export function inputHooks(call, signal, limit = 128) {
  const bindings = new Map();
  const bind = async (anchor) => {
    const reply = await call({ operation: "bind", ...anchor }, signal);
    if (!object(reply) || !(reply.token === null || typeof reply.token === "string" && reply.token.length && Buffer.byteLength(reply.token) <= 512)) throw new Error("malformed native input bind response");
    if (reply.token === null || signal.aborted) return;
    const previous = bindings.get(anchor.sessionID);
    if (previous && compareUsers(anchor, previous.anchor) < 0) return;
    if (!previous && bindings.size >= limit) throw new Error("native input binding limit reached");
    const binding = Object.freeze({ anchor, token: reply.token });
    bindings.set(anchor.sessionID, binding);
    return binding;
  };
  return {
    clear: () => bindings.clear(),
    "chat.message": async (input, output) => {
      const anchor = userTuple(output?.message);
      if (input?.sessionID !== anchor.sessionID) throw new Error("native input admission mixes sessions");
      await bind(anchor);
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      // Freeze the exact object, chronology and binding before the first await.
      const { message, tuple, after } = currentUser(output?.messages);
      // A Task's first prompt can precede its public-tool adoption. Only a
      // never-bound context may try the existing exact live-owner guard here;
      // a refused step with an accepted token must never rebind generations.
      const binding = bindings.get(tuple.sessionID) ?? await bind(tuple);
      if (!binding || compareUsers(tuple, binding.anchor) < 0) return;
      const reply = await call({ operation: "step", ...tuple, token: binding.token, after }, signal);
      if (!object(reply) || !Array.isArray(reply.parts)) throw new Error("malformed native input step response");
      for (const part of reply.parts) {
        if (!object(part) || partFloor(part.id) <= after || part.type !== "text" || typeof part.text !== "string" || part.sessionID !== tuple.sessionID || part.messageID !== tuple.messageID) throw new Error("native input part does not match the frozen user");
        if (!message.parts.some((existing) => existing.id === part.id)) message.parts.push(part);
      }
    },
  };
}

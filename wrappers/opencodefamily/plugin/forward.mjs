// SPDX-License-Identifier: MIT
import { nativeProduct } from "./profile.mjs";

import net from "node:net";

export const bridgeLimits = Object.freeze({ input: 2 * 1024 * 1024, response: 8 * 1024 * 1024, work: 256, retained: 32 * 1024 * 1024, connections: 8 });

function aborted(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("native tool call cancelled");
}

function nativeID(value, prefix) {
  return typeof value === "string" && value.startsWith(prefix) && Buffer.byteLength(value) <= 256 && !/[\s\0]/u.test(value);
}

export class ForwardedToolError extends Error {
  constructor(value) {
    super(typeof value?.message === "string" ? value.message : JSON.stringify(value));
    this.name = "ForwardedToolError";
    this.value = value;
  }
}

// One resident native plugin connection, never a reconnecting request client.
// Cancellation discards that caller's response but keeps writes connection-owned
// until completion/close. MCP permits no response to a cancelled request.
export class SessionbusForwarder {
  #socket;
  #initializing;
  #readyState = false;
  #readyWaiters = new Set();
  #closed;
  #failure;
  #sequence = 0;
  #pending = new Map();
  #operations = 0;
  #writeBytes = 0;
  #writes = new Map();
  #frame = Buffer.alloc(0);
  #readBytes = 0;

  constructor(path, lifetime) {
    this.#socket = net.createConnection(path);
    this.#closed = new Promise((resolve) => this.#socket.once("close", resolve));
    const connected = new Promise((resolve, reject) => {
      const stop = () => { cleanup(); reject(this.#failure || new Error("MCP connection closed before initialize")); };
      const start = () => { cleanup(); resolve(); };
      const cleanup = () => { this.#socket.removeListener("connect", start); this.#socket.removeListener("close", stop); };
      this.#socket.once("connect", start);
      this.#socket.once("close", stop);
    });
    const end = () => this.#fail(new Error("MCP connection ended"));
    this.#socket.on("error", (error) => this.#fail(error));
    this.#socket.on("end", end);
    this.#socket.on("close", () => {
      end();
      // Bun may omit callbacks for buffered writes destroyed with the socket.
      // Actual close ends transport ownership; destroy() alone does not.
      for (const complete of this.#writes.values()) complete(this.#failure);
      lifetime?.removeEventListener("abort", cancel);
    });
    this.#socket.on("data", (chunk) => this.#receive(chunk));
    const cancel = () => this.#fail(aborted(lifetime));
    lifetime?.addEventListener("abort", cancel, { once: true });
    if (lifetime?.aborted) cancel();
    this.#initializing = connected.then(async () => {
      const result = await this.#request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: `sessionbus-${nativeProduct.product}`, version: "1" } });
      if (result?.protocolVersion !== "2024-11-05" || !result.capabilities || typeof result.capabilities.tools !== "object" || result.capabilities.tools === null) throw new Error("endpoint did not initialize Sessionbus tools");
      this.#send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      const catalog = await this.#request("tools/list", {});
      if (!Array.isArray(catalog?.tools) || catalog.tools.length !== 1 || catalog.tools[0]?.name !== "sessionbus") throw new Error("endpoint did not advertise the single Sessionbus tool");
      this.#readyState = true;
      for (const complete of [...this.#readyWaiters]) complete();
    }).catch((error) => this.#fail(error));
  }

  ready(signal) {
    if (this.#failure) return Promise.reject(this.#failure);
    if (signal?.aborted) return Promise.reject(aborted(signal));
    if (this.#readyState) return Promise.resolve();
    if (this.#readyWaiters.size >= bridgeLimits.work) return Promise.reject(new Error("Sessionbus readiness wait limit reached"));
    return new Promise((resolve, reject) => {
      const complete = (error) => {
        signal?.removeEventListener("abort", cancel);
        this.#readyWaiters.delete(complete);
        if (error) reject(error); else resolve();
      };
      const cancel = () => complete(aborted(signal));
      this.#readyWaiters.add(complete);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  async action(action, argumentsValue, context) {
    if (!nativeID(context?.sessionID, "ses_") || !nativeID(context?.messageID, "msg_")) throw new Error(`native ${nativeProduct.label} tool identity is missing or malformed`);
    if (this.#operations >= bridgeLimits.work) throw new Error("Sessionbus forwarder work limit reached");
    this.#operations++;
    try {
      await this.ready(context.abort);
      const result = await this.#request("tools/call", { name: "sessionbus", arguments: { action, arguments: argumentsValue }, _meta: { [nativeProduct.metadataKey]: { session_id: context.sessionID, message_id: context.messageID } } }, context.abort);
      if (!result || !Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== "text" || typeof result.content[0].text !== "string" || result.isError !== undefined && typeof result.isError !== "boolean") throw new Error("malformed Sessionbus MCP tool result");
      const value = JSON.parse(result.content[0].text);
      if (result.isError) throw new ForwardedToolError(value);
      return value;
    } finally {
      this.#operations--;
    }
  }

  async nativeInput(parameters, signal) {
    if (this.#operations >= bridgeLimits.work) throw new Error("Sessionbus forwarder work limit reached");
    this.#operations++;
    try {
      await this.ready(signal);
      return await this.#request("sessionbus/native-input", parameters, signal);
    } finally { this.#operations--; }
  }

  async dispose() {
    this.#fail(new Error("Sessionbus forwarder disposed"));
    await this.#closed;
    await this.#initializing;
    await Promise.allSettled([...this.#writes.keys()]);
  }

  #request(method, params, signal) {
    if (this.#failure) return Promise.reject(this.#failure);
    if (signal?.aborted) return Promise.reject(aborted(signal));
    if (this.#pending.size >= bridgeLimits.work || this.#sequence >= Number.MAX_SAFE_INTEGER) return Promise.reject(new Error("Sessionbus MCP request limit reached"));
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const cleanup = () => { signal?.removeEventListener("abort", cancel); this.#pending.delete(id); };
      const complete = (error, value) => { cleanup(); if (error) reject(error); else resolve(value); };
      const cancel = () => {
        cleanup();
        reject(aborted(signal));
        try { this.#send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }); }
        catch (error) { this.#fail(error); }
      };
      this.#pending.set(id, complete);
      signal?.addEventListener("abort", cancel, { once: true });
      try { this.#send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { complete(error); }
    });
  }

  #send(value) {
    if (this.#failure) throw this.#failure;
    const frame = Buffer.from(JSON.stringify(value) + "\n");
    if (frame.length > bridgeLimits.input) throw new Error("Sessionbus MCP input exceeds 2 MiB");
    if (this.#writes.size >= bridgeLimits.work || this.#writeBytes + this.#frame.length + frame.length > bridgeLimits.retained) throw new Error("Sessionbus MCP retained write limit reached");
    this.#writeBytes += frame.length;
    let done;
    const writing = new Promise((resolve) => { done = resolve; });
    let settled = false;
    const complete = (error) => {
      if (settled) return;
      settled = true;
      this.#writeBytes -= frame.length;
      this.#writes.delete(writing);
      done();
      if (error) this.#fail(error);
    };
    this.#writes.set(writing, complete);
    try { this.#socket.write(frame, complete); }
    catch (error) { complete(error); throw error; }
  }

  #receive(chunk) {
    if (this.#failure) return;
    let offset = 0;
    while (offset < chunk.length && !this.#failure) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      const needed = this.#readBytes + part.length;
      if (needed > bridgeLimits.response) { this.#fail(new Error("Sessionbus MCP response exceeds 8 MiB")); return; }
      if (needed > this.#frame.length) {
        const capacity = Math.min(bridgeLimits.response, Math.max(4096, needed, this.#frame.length * 2));
        if (capacity + this.#writeBytes > bridgeLimits.retained) { this.#fail(new Error("Sessionbus MCP retained payload limit reached")); return; }
        const next = Buffer.allocUnsafe(capacity);
        this.#frame.copy(next, 0, 0, this.#readBytes);
        this.#frame = next;
      }
      part.copy(this.#frame, this.#readBytes);
      this.#readBytes = needed;
      if (newline < 0) return;
      const frame = this.#frame.subarray(0, this.#readBytes);
      this.#readBytes = 0;
      offset = newline + 1;
      if (!frame.length) continue;
      try {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
        if (value?.jsonrpc !== "2.0" || !Number.isSafeInteger(value.id) || value.id <= 0 || value.id > this.#sequence || Object.hasOwn(value, "result") === Object.hasOwn(value, "error") || Object.hasOwn(value, "method")) throw new Error("invalid MCP response envelope");
        if (Object.hasOwn(value, "error") && (!value.error || !Number.isInteger(value.error.code) || typeof value.error.message !== "string")) throw new Error("invalid MCP error envelope");
        const pending = this.#pending.get(value.id);
        // A cancellation can win after the server already queued a response;
        // completed/cancelled IDs need no unbounded tombstone ledger.
        if (pending) pending(value.error ? new ForwardedToolError(value.error) : undefined, value.result);
      } catch (error) { this.#fail(error); }
    }
  }

  #fail(error) {
    if (this.#failure) return;
    this.#failure = error instanceof Error ? error : new Error(String(error));
    for (const complete of [...this.#readyWaiters]) complete(this.#failure);
    for (const complete of [...this.#pending.values()]) complete(this.#failure);
    this.#frame = Buffer.alloc(0);
    this.#readBytes = 0;
    this.#socket.destroy();
  }
}

// SPDX-License-Identifier: MIT
import { nativeProduct } from "./profile.mjs";
import net from "node:net";
import { chmod } from "node:fs/promises";
import tool from "./sessionbus-tool.json" with { type: "json" };
import { bridgeLimits } from "./forward.mjs";

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nativeID(value, prefix) { return typeof value === "string" && value.startsWith(prefix) && Buffer.byteLength(value) <= 256 && !/[\s\0]/u.test(value); }
function errorResult(error) {
  const value = Number.isInteger(error?.code)
    ? { code: error.code, message: String(error.message), ...(error.data === undefined ? {} : { data: error.data }) }
    : { error: String(error?.message || error) };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(value) }] };
}

// One native-TUI-owned endpoint, shared by bounded native server instances.
// All request metadata remains per call. Closing a connection cancels only its
// own actions; deletion/TUI disposal separately owns the per-session Peers.
export class InteractiveEndpoint {
  #server;
  #connections = new Set();
  #closing;
  #closed = false;
  #work = 0;
  #bytes = 0;
  #action;
  #nativeInput;
  #listening;

  constructor(path, action, nativeInput) {
    this.#action = action;
    this.#nativeInput = nativeInput;
    this.#server = net.createServer((socket) => {
      if (this.#closed || this.#connections.size >= bridgeLimits.connections) { socket.destroy(); return; }
      const connection = new EndpointConnection(socket, this);
      this.#connections.add(connection);
      connection.closed.finally(() => this.#connections.delete(connection));
    });
    this.#listening = new Promise((resolve, reject) => {
      const error = (value) => { this.#server.removeListener("listening", listening); reject(value); };
      const listening = () => { this.#server.removeListener("error", error); resolve(); };
      this.#server.once("error", error);
      this.#server.once("listening", listening);
      this.#server.listen(path);
    }).then(() => chmod(path, 0o600));
    this.#listening.catch(() => {});
    this.#server.on("error", () => { void this.dispose(); });
  }

  ready() { return this.#listening; }

  reserve(bytes, work = 0) {
    if (this.#closed || this.#work + work > bridgeLimits.work || this.#bytes + bytes > bridgeLimits.retained) throw new Error("Sessionbus endpoint capacity exhausted");
    this.#work += work;
    this.#bytes += bytes;
  }
  release(bytes, work = 0) { this.#bytes -= bytes; this.#work -= work; }

  async call(params, signal) {
    const args = params?.arguments;
    const native = params?._meta?.[nativeProduct.metadataKey];
    if (params?.name !== "sessionbus" || !object(args) || Object.keys(args).length !== 2 || !tool.inputSchema.properties.action.enum.includes(args.action) || !object(args.arguments)) throw new Error("expected a Sessionbus action and arguments object");
    if (!object(native) || Object.keys(native).length !== 2 || !nativeID(native.session_id, "ses_") || !nativeID(native.message_id, "msg_")) throw new Error(`native ${nativeProduct.label} tool identity is missing or malformed`);
    if (signal.aborted) throw signal.reason;
    return this.#action(args.action, args.arguments, { sessionID: native.session_id, messageID: native.message_id, signal });
  }

  nativeInput(params, signal) {
    if (!this.#nativeInput) throw Object.assign(new Error("Method not found"), { code: -32601 });
    if (signal.aborted) throw signal.reason;
    return this.#nativeInput(params, signal);
  }

  dispose() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      // A pending listen must settle before close; no new connections can be
      // admitted after #closed. No resource belongs to a future reconnect.
      await this.#listening.catch(() => {});
      const connections = [...this.#connections];
      for (const connection of connections) connection.stop();
      await new Promise((resolve) => this.#server.close(() => resolve()));
      await Promise.all(connections.map((connection) => connection.closed));
    })();
    return this.#closing;
  }
}

class EndpointConnection {
  #socket;
  #endpoint;
  #controller = new AbortController();
  #frame = Buffer.alloc(0);
  #used = 0;
  #pending = new Map();
  #tasks = new Set();
  #writes = new Map();
  closed;

  constructor(socket, endpoint) {
    this.#socket = socket;
    this.#endpoint = endpoint;
    const closed = new Promise((resolve) => socket.once("close", resolve));
    this.closed = (async () => {
      await closed;
      this.stop();
      // Actual socket close releases buffered write ownership even when Bun
      // omits its callbacks. Later callbacks share the same idempotent guard.
      for (const done of this.#writes.values()) done(this.#controller.signal.reason);
      await Promise.allSettled([...this.#tasks, ...this.#writes.keys()]);
    })();
    socket.on("error", () => this.stop());
    socket.on("end", () => this.stop());
    socket.on("data", (chunk) => this.#read(chunk));
  }

  stop() {
    if (this.#controller.signal.aborted) return;
    this.#controller.abort(new Error("native MCP connection ended"));
    for (const controller of this.#pending.values()) controller.abort(this.#controller.signal.reason);
    this.#endpoint.release(this.#frame.length);
    this.#frame = Buffer.alloc(0);
    this.#used = 0;
    this.#socket.destroy();
  }

  #read(chunk) {
    let offset = 0;
    try {
      while (offset < chunk.length && !this.#controller.signal.aborted) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        const needed = this.#used + part.length;
        if (needed >= bridgeLimits.input) throw new Error("MCP input frame exceeds 2 MiB");
        if (needed > this.#frame.length) {
          const capacity = Math.min(bridgeLimits.input, Math.max(4096, needed, this.#frame.length * 2));
          this.#endpoint.reserve(capacity - this.#frame.length);
          const next = Buffer.allocUnsafe(capacity);
          this.#frame.copy(next, 0, 0, this.#used);
          this.#frame = next;
        }
        part.copy(this.#frame, this.#used);
        this.#used = needed;
        if (newline < 0) return;
        offset = newline + 1;
        const size = this.#used;
        this.#used = 0;
        if (!size) continue;
        const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.#frame.subarray(0, size)));
        this.#request(request, size);
      }
    } catch { this.stop(); }
  }

  #request(request, size) {
    if (!object(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string" || Object.hasOwn(request, "result") || Object.hasOwn(request, "error")) throw new Error("invalid MCP request");
    if (!Object.hasOwn(request, "id")) {
      if (request.method === "notifications/cancelled") this.#pending.get(request.params?.requestId)?.abort(new Error("native tool cancelled"));
      else if (request.method !== "notifications/initialized") throw new Error("unknown MCP notification");
      return;
    }
    const id = request.id;
    if (!Number.isSafeInteger(id) || id <= 0 || this.#pending.has(id)) throw new Error("invalid or duplicate MCP request ID");
    this.#endpoint.reserve(size, 1);
    const controller = new AbortController();
    this.#pending.set(id, controller);
    const task = Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      let result;
      let error;
      switch (request.method) {
        case "initialize":
          if (typeof request.params?.protocolVersion !== "string") { error = { code: -32602, message: "protocolVersion is required" }; break; }
          result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "sessionbus", version: "1" } };
          break;
        case "tools/list": result = { tools: [tool] }; break;
        case "ping": result = {}; break;
        case "tools/call":
          try { result = { content: [{ type: "text", text: JSON.stringify(await this.#endpoint.call(request.params, controller.signal)) ?? "{}" }] }; }
          catch (cause) { result = errorResult(cause); }
          break;
        case "sessionbus/native-input":
          try { result = await this.#endpoint.nativeInput(request.params, controller.signal); }
          catch (cause) { error = { code: Number.isInteger(cause?.code) ? cause.code : -32603, message: String(cause?.message || cause) }; }
          break;
        default: error = { code: -32601, message: "Method not found" };
      }
      if (controller.signal.aborted || this.#controller.signal.aborted) return;
      await this.#write({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) });
    }).catch(() => this.stop()).finally(() => {
      this.#pending.delete(id);
      this.#endpoint.release(size, 1);
      this.#tasks.delete(task);
    });
    this.#tasks.add(task);
  }

  #write(value) {
    const frame = Buffer.from(JSON.stringify(value) + "\n");
    if (frame.length > bridgeLimits.response) throw new Error("MCP response exceeds 8 MiB");
    this.#endpoint.reserve(frame.length);
    let resolve, reject;
    const writing = new Promise((yes, no) => { resolve = yes; reject = no; });
    let complete = false;
    const done = (error) => {
      if (complete) return;
      complete = true;
      this.#endpoint.release(frame.length);
      if (error) reject(error); else resolve();
    };
    this.#writes.set(writing, done);
    try { this.#socket.write(frame, done); } catch (error) { done(error); }
    writing.finally(() => this.#writes.delete(writing)).catch(() => {});
    return writing;
  }
}

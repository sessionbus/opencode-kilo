// SPDX-License-Identifier: MIT

import { nativeProduct } from "./profile.mjs";
import { createHash, randomBytes } from "node:crypto";

export const deliveryLimits = Object.freeze({ messages: 64, ownerBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024 });

// Preserve the product's retained structured sender rendering. The native
// message ID identifies this submission; it is never a session identity.
export function renderDelivery(request) {
  const clean = (value) => String(value).replace(/["<>\r\n]/gu, "");
  const escaped = { "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029" };
  const metadata = JSON.stringify({ fromProduct: request.from.product, messageId: request.message_id, groups: request.from.groups || [] })
    .replace(/[<>&\u2028\u2029]/gu, (character) => escaped[character]);
  const body = request.body.replace(/<\/cross-session-message/giu, "<\\/cross-session-message");
  return `<cross-session-message from="${clean(request.from.name || request.from.session_id)}" from-session="${clean(request.from.session_id)}">\n[sessionbus-metadata: ${metadata}]\n${body}\n</cross-session-message>`;
}

// Native orders a message's parts by ID (fixed-width `prt_` + 12 hex + 14
// base62, compared bytewise). A handed-off part must sort after the current
// user's existing parts, so derive it from the native clock encoding and never
// below `after`. An unrecognised floor means no handoff at this step.
const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function nextPartID(after, now = Date.now(), entropy = randomBytes) {
  if (typeof after !== "string" || !/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/u.test(after)) return undefined;
  const floor = BigInt(`0x${after.slice(4, 16)}`);
  let head = (BigInt(now) * 4096n) & 0xffffffffffffn;
  if (head <= floor) head = floor + 1n;
  if (head > 0xffffffffffffn) return undefined;
  return `prt_${head.toString(16).padStart(12, "0")}${[...entropy(14)].map((byte) => base62[byte % 62]).join("")}`;
}

export class NativeDelivery {
  #options;
  #queue = [];
  #bytes = 0;
  #active;
  #closed = false;
  #idleDemand = false;

  constructor(options) { this.#options = options; }

  async enqueue(signal, request) {
    if (this.#closed || signal.aborted || this.#options.signal.aborted) return { disposition: "rejected", reason: "native owner closed" };
    const text = renderDelivery(request), bytes = Buffer.byteLength(text);
    if (this.#queue.length >= deliveryLimits.messages || this.#bytes + bytes > deliveryLimits.ownerBytes || !this.#options.reserve(bytes)) {
      return { disposition: "rejected", reason: "Sessionbus unsent input limit reached" };
    }
    const item = { text, bytes, id: `msg_${createHash("sha256").update(request.message_id).digest("hex").slice(0, 32)}`, attempted: false, written: false };
    this.#bytes += bytes;
    this.#queue.push(item);
    if (this.#active || this.#queue[0] !== item) return { disposition: "queued_for_next_turn" };
    try {
      await this.#drain(signal);
      return { disposition: item.written ? "written" : "queued_for_next_turn" };
    } catch (error) {
      if (item.written) {
        this.#options.report?.(error);
        return { disposition: "written" };
      }
      // Previously receipted unsent entries remain local. This new unreceipted
      // item must not execute after its rejection; attempted input was removed
      // before invoking native HTTP and is never restored on uncertainty.
      this.#remove(item);
      return { disposition: "rejected", reason: String(error?.message || error) };
    }
  }

  idle() {
    if (this.#closed || !this.#queue.length) return Promise.resolve();
    this.#idleDemand = true;
    return this.#drain(this.#options.signal);
  }

  // Busy handoff at a native model step: hand the FIFO prefix to `patch`, which
  // appends it to the current user message. It shares the idle drain's single
  // consumer slot, so a step never overlaps a submission. Items leave the FIFO
  // only when `patch` reports the native write started; anything not taken stays
  // queued for a later step or the idle drain. Attempted input is never retried.
  async take(signal, patch) {
    if (this.#closed || this.#active || !this.#queue.length) return undefined;
    let settle;
    this.#active = new Promise((resolve) => { settle = resolve; });
    try {
      const items = [];
      let bytes = 0;
      for (const item of this.#queue) {
        if (items.length && bytes + item.bytes > deliveryLimits.ownerBytes) break;
        items.push(item);
        bytes += item.bytes;
      }
      const cancel = AbortSignal.any([signal, this.#options.signal]);
      const part = await patch(items.map((item) => item.text).join("\n\n"), cancel, () => {
        for (const item of items) { this.#remove(item); item.attempted = true; }
      });
      for (const item of items) item.written = true;
      return part;
    } finally {
      this.#active = undefined;
      settle();
      if (this.#idleDemand && !this.#closed && this.#queue.length) void this.idle().catch((error) => this.#options.report?.(error));
    }
  }

  #drain(signal) {
    if (this.#active) return this.#active;
    const cancel = AbortSignal.any([signal, this.#options.signal]);
    let resolve, reject;
    const task = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Reserve before any supplied/native callback can synchronously signal idle.
    this.#active = task;
    void (async () => {
      try {
        do {
          this.#idleDemand = false;
          while (!this.#closed && this.#queue.length) {
            if (cancel.aborted) throw cancel.reason;
            // Query native status even for the first/resumed owner. Missing local
            // events are never interpreted as idle. Native status.list omits idle
            // sessions; the manager validates that source-bound response shape.
            if (await this.#options.status(cancel) !== "idle") break;
            const info = await this.#options.info(cancel);
            if (cancel.aborted || this.#closed) throw cancel.reason || new Error("native owner closed");
            if (this.#options.maySubmit && !this.#options.maySubmit()) break;
            const item = this.#queue[0];
            if (!item) return;
            const model = info.model && { providerID: info.model.providerID, modelID: info.model.id };
            const parameters = { sessionID: this.#options.sessionID, directory: info.directory,
              ...(nativeProduct.nativeMessageID ? {} : { messageID: item.id }), parts: [{ type: "text", text: item.text }],
              ...(info.agent ? { agent: info.agent } : {}), ...(model ? { model } : {}),
              ...(info.model?.variant && info.model.variant !== "default" ? { variant: info.model.variant } : {}),
            };
            // Removing from local FIFO is the attempted-handoff boundary. A native
            // busy/terminal race may store input without consuming it in that turn.
            const submitted = await this.#options.submit(parameters, cancel, () => {
              this.#remove(item);
              item.attempted = true;
            });
            if (nativeProduct.blockers && submitted === false) break;
            item.written = true;
          }
        } while (this.#idleDemand && !this.#closed && this.#queue.length);
      } finally {
        // Clear before settling the result: an idle event after this point owns
        // a new drain rather than subscribing to an already-completed promise.
        this.#active = undefined;
      }
    })().then(resolve, reject);
    return task;
  }

  #remove(item) {
    const index = this.#queue.indexOf(item);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#bytes -= item.bytes;
    this.#options.release(item.bytes);
  }

  async dispose() {
    this.#closed = true;
    for (const item of [...this.#queue]) this.#remove(item);
    await Promise.allSettled(this.#active ? [this.#active] : []);
  }
}

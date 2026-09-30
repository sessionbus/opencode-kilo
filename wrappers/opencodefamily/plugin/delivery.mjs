// SPDX-License-Identifier: MIT

import { nativeProduct } from "./profile.mjs";
import { createHash } from "node:crypto";
import { orderedPartID, partFloor } from "./native-input.mjs";

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

export class NativeDelivery {
  #options;
  #queue = [];
  #bytes = 0;
  #active;
  #closed = false;
  #idleDemand = false;
  #partFloor;

  constructor(options) { this.#options = options; }

  async enqueue(signal, request) {
    if (this.#closed || signal.aborted || this.#options.signal.aborted) return { disposition: "rejected", reason: "native owner closed" };
    const text = renderDelivery(request), bytes = Buffer.byteLength(text);
    // Leave room for the exact native tuple and JSON part framing too. The raw
    // private reply shares the public one-MiB returned-data limit.
    if (Buffer.byteLength(JSON.stringify({ text })) + 1024 > deliveryLimits.ownerBytes || this.#queue.length >= deliveryLimits.messages || this.#bytes + bytes > deliveryLimits.ownerBytes || !this.#options.reserve(bytes)) {
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
    if (this.#closed) return Promise.resolve();
    this.#idleDemand = true;
    if (!this.#queue.length && !this.#active) return Promise.resolve();
    return this.#drain(this.#options.signal);
  }

  async step(signal, user, mayAttempt) {
    // Hook and idle wake share one claim boundary, not a second inbox. A native
    // step can arrive while an earlier status query is still settling.
    while (this.#active) await this.#active;
    const cancel = AbortSignal.any([signal, this.#options.signal]);
    if (cancel.aborted || this.#closed) throw cancel.reason || new Error("native owner closed");
    if (!mayAttempt()) return [];
    const after = partFloor(user.after);
    if (this.#partFloor?.messageID !== user.messageID || this.#partFloor?.sessionID !== user.sessionID) this.#partFloor = undefined;
    if (!this.#queue.length || !mayAttempt()) return [];
    const id = orderedPartID(this.#partFloor?.id > after ? this.#partFloor.id : after);
    let resolve, reject;
    const task = new Promise((yes, no) => { resolve = yes; reject = no; });
    this.#active = task;
    void (async () => {
      const part = { id, sessionID: user.sessionID, messageID: user.messageID, type: "text", text: "" };
      const batch = [];
      for (const item of this.#queue) {
        const text = part.text ? `${part.text}\n\n${item.text}` : item.text;
        if (Buffer.byteLength(JSON.stringify({ parts: [{ ...part, text }] })) > deliveryLimits.ownerBytes) break;
        part.text = text;
        batch.push(item);
      }
      if (!batch.length) throw new Error("native input part exceeds returned-data limit");
      if (cancel.aborted || !mayAttempt()) return [];
      const confirmed = await this.#options.patch(part, cancel, () => {
        if (cancel.aborted || !mayAttempt()) return false;
        this.#partFloor = { id, sessionID: user.sessionID, messageID: user.messageID };
        for (const item of batch) { this.#remove(item); item.attempted = true; }
      });
      if (confirmed === false) return [];
      if (confirmed?.id !== part.id || confirmed.sessionID !== part.sessionID || confirmed.messageID !== part.messageID || confirmed.type !== "text" || confirmed.text !== part.text) throw new Error("native input part response was not confirmed");
      return [confirmed];
    })().then(resolve, reject).finally(() => {
      this.#active = undefined;
      if (this.#idleDemand && !this.#closed && this.#queue.length) void this.idle().catch((error) => this.#options.report?.(error));
    });
    return task;
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
    this.#partFloor = undefined;
    for (const item of [...this.#queue]) this.#remove(item);
    await Promise.allSettled(this.#active ? [this.#active] : []);
  }
}

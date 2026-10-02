// SPDX-License-Identifier: MIT

import net from "node:net";
import { connectPeer } from "@sessionbus/kit";
import { ReadyGate } from "./gate.mjs";
import { nativeProduct } from "./profile.mjs";

// Keep the kit's reconnect/hello policy. This owner only binds its attempt
// observations and actual sockets/timers to the native session's lifetime.
export class OwnedPeer {
  #peer;
  #id;
  #controller = new AbortController();
  #gate = new ReadyGate();
  #sockets = new Map();
  #timers = new Set();
  #tasks = new Set();
  #observed = new WeakSet();
  #dispose;

  constructor(identity, deliver, env, options = {}) {
    this.#id = identity.session_id;
    const connect = options.connect || ((path) => net.createConnection(path));
    const schedule = options.schedule || ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    });
    this.#peer = connectPeer(identity, (signal, message, admitted) => {
      if (this.signal.aborted) return { disposition: "rejected", reason: "native owner closed" };
      return this.#track(() => deliver(AbortSignal.any([signal, this.signal]), message, admitted));
    }, { ...env }, {
      connect: (path) => {
        if (this.signal.aborted) throw this.signal.reason;
        const socket = connect(path);
        const closed = new Promise((resolve) => socket.once("close", () => {
          this.#sockets.delete(socket);
          // The kit's close listener clears admission after this listener.
          this.#reset();
          resolve();
        }));
        this.#sockets.set(socket, closed);
        return socket;
      },
      schedule: (callback, delay) => {
        if (this.signal.aborted) return;
        const entry = { cancel: undefined };
        this.#timers.add(entry);
        entry.cancel = schedule(() => {
          this.#timers.delete(entry);
          if (this.signal.aborted) return;
          callback();
          this.#observe();
        }, delay);
      },
    });
    this.#observe();
    // A permanent hello refusal never resolves kit.ready; kit.closed is its
    // terminal boundary. Exactly one subscriber exists for the owner's life.
    void this.#peer.closed.then(() => this.dispose(this.#peer.error || new Error("Sessionbus peer closed")));
  }

  get signal() { return this.#controller.signal; }
  get terminal() { return this.#peer.terminal; }

  // A terminal kit peer (superseded, or its hello refused) never becomes ready
  // again, even while its closed is still pending; its reason ends the waits.
  #ended() {
    if (!this.#peer.terminal) return undefined;
    const error = this.#peer.error || new Error("Sessionbus peer closed");
    // The owner-approved text for a Kilo session another launch took over
    // (2026-10-02). Kilo only: on OpenCode it would name the wrong launcher.
    if (nativeProduct.product !== "kilo" || error.code !== -32012) return error;
    return Object.assign(new Error("Sessionbus: another kilo-peer launch took over this session (superseded); relaunch to use Sessionbus here", { cause: error }), { code: error.code });
  }

  #live() {
    const peer = this.#peer;
    return !this.signal.aborted && !peer.terminal && peer.connection &&
      !peer.connection.signal.aborted && peer.admitted?.session_id === this.#id &&
      peer.identityController && !peer.identityController.signal.aborted;
  }

  #reset() {
    if (this.signal.aborted) return;
    // Existing unadmitted subscribers stay on the same gate. A connected gate
    // is replaced on loss; callers always recheck admission after awaiting it.
    if (this.#admittedGate === this.#gate) this.#gate = new ReadyGate();
  }
  #admittedGate;

  #observe() {
    const ready = this.#peer.ready;
    if (!ready || this.#observed.has(ready)) return;
    this.#observed.add(ready);
    void ready.then(() => {
      if (!this.#live()) return;
      const identity = this.#peer.identityController;
      identity.signal.addEventListener("abort", () => this.#reset(), { once: true });
      this.#admittedGate = this.#gate;
      this.#gate.settle(undefined, this.#peer);
    }, (error) => this.dispose(error));
  }

  async ready(signal) {
    const cancel = signal ? AbortSignal.any([signal, this.signal]) : this.signal;
    while (!this.#live()) {
      if (cancel.aborted) throw cancel.reason;
      const ended = this.#ended();
      if (ended) throw ended;
      this.#reset();
      await this.#gate.wait(cancel);
    }
    if (cancel.aborted) throw cancel.reason;
  }

  action(action, args, signal) {
    return this.#track(async () => {
      const cancel = signal ? AbortSignal.any([signal, this.signal]) : this.signal;
      await this.ready(cancel);
      return this.#peer.caller.action(action, args, cancel);
    });
  }

  rehello(name, info) {
    return this.#track(async () => {
      await this.ready();
      // Keep the full kit operation owned until acknowledgement or wire loss;
      // its optional caller-context wrapper could return before this settles.
      return this.#peer.rehello(undefined, name || undefined, info);
    });
  }

  #track(operation) {
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    if (this.#tasks.size >= 256) return Promise.reject(new Error("Sessionbus owner work limit reached"));
    const task = Promise.resolve().then(() => {
      if (this.signal.aborted) throw this.signal.reason;
      return operation();
    });
    this.#tasks.add(task);
    void task.then(() => this.#tasks.delete(task), () => this.#tasks.delete(task));
    return task;
  }

  dispose(reason = new Error("native owner closed")) {
    if (this.#dispose) return this.#dispose;
    this.#controller.abort(reason);
    this.#gate.settle(reason);
    for (const timer of this.#timers) timer.cancel?.();
    this.#timers.clear();
    this.#peer.shutdown();
    const sockets = [...this.#sockets];
    for (const [socket] of sockets) socket.destroy();
    this.#dispose = (async () => {
      await Promise.all(sockets.map(([, closed]) => closed));
      await Promise.allSettled([...this.#tasks]);
    })();
    return this.#dispose;
  }
}

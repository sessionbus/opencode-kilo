// SPDX-License-Identifier: MIT
import { nativeProduct } from "./profile.mjs";

import { validate } from "@sessionbus/kit";
import { OwnedPeer } from "./peer.mjs";
import { NativeDelivery, deliveryLimits, nextPartID } from "./delivery.mjs";
import { ReadyGate } from "./gate.mjs";

export const ownerLimits = Object.freeze({ owners: 128, establishing: 16, http: 256 });
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
function nativeID(id) { return typeof id === "string" && id.startsWith("ses_") && Buffer.byteLength(id) <= 128 && !/[\s\0]/u.test(id); }
function nativeInfo(value, id) {
  if (!object(value) || value.id !== id || typeof value.title !== "string" || typeof value.directory !== "string" || Buffer.byteLength(value.directory) > 65536) throw new Error(`${nativeProduct.label} returned invalid native session identity`);
  if (value.model !== undefined && (!object(value.model) || typeof value.model.providerID !== "string" || typeof value.model.id !== "string" || value.model.variant !== undefined && typeof value.model.variant !== "string")) throw new Error(`${nativeProduct.label} returned invalid native model identity`);
  if (value.agent !== undefined && typeof value.agent !== "string") throw new Error(`${nativeProduct.label} returned invalid native agent identity`);
  const selection = [value.agent, value.model?.providerID, value.model?.id, value.model?.variant];
  if (selection.some((field) => field !== undefined && Buffer.byteLength(field) > 4096)) throw new Error(`${nativeProduct.label} native selection metadata exceeds limit`);
  return { id, title: value.title, directory: value.directory, ...(value.agent === undefined ? {} : { agent: value.agent }),
    ...(value.model === undefined ? {} : { model: { providerID: value.model.providerID, id: value.model.id, ...(value.model.variant === undefined ? {} : { variant: value.model.variant }) } }),
  };
}

// One native TUI lifetime, independent native-ID owners. Listeners are installed
// before the first GET/hello so deletion invalidates pending generations too.
export class NativeOwners {
  #api;
  #binding;
  #options;
  #controller = new AbortController();
  #owners = new Map();
  #records = new Set();
  #pending = 0;
  #http = new Set();
  #work = new Set();
  #unsub = [];
  #bytes = 0;
  #named = false;
  #dispose;

  constructor(api, binding, options = {}) {
    this.#api = api;
    this.#binding = binding;
    this.#options = options;
    this.#unsub.push(api.event.on("session.deleted", (event) => {
      const record = this.#owners.get(event.properties.info.id);
      if (record) this.#background(this.#retire(record, new Error("native session deleted")));
    }));
    this.#unsub.push(api.event.on("session.updated", (event) => {
      const record = this.#owners.get(event.properties.info.id);
      if (!record) return;
      try { record.info = nativeInfo(event.properties.info, record.id); record.revision++; }
      catch (error) { this.#background(this.#retire(record, error)); return; }
      if (record.peer) this.#refresh(record);
    }));
    this.#unsub.push(api.event.on("session.status", (event) => {
      const record = this.#owners.get(event.properties.sessionID);
      if (!record) return;
      const status = event.properties.status?.type;
      if (!["idle", "busy", "retry"].includes(status)) {
        this.#background(this.#retire(record, new Error(`${nativeProduct.label} returned malformed native status`)));
        return;
      }
      record.status = status;
      record.statusRevision++;
      // Only an idle observed after the assistant's completion follows the
      // native Runner's removal; the halt's earlier idle does not settle it.
      if (status === "idle" && nativeProduct.terminalHandoff) record.settled = record.completed;
      if (status === "idle" && record.delivery) this.#background(record.delivery.idle());
    }));
    if (nativeProduct.blockers) {
      for (const type of ["permission.asked", "permission.replied", "question.asked", "question.replied", "question.rejected"]) {
        this.#unsub.push(api.event.on(type, (event) => {
          const record = this.#owners.get(event.properties.sessionID);
          if (!record) return;
          record.blockerEpoch = {};
          if (record.delivery) this.#background(record.delivery.idle());
        }));
      }
    }
    if (nativeProduct.terminalHandoff) {
      this.#unsub.push(api.event.on("message.updated", (event) => {
        const info = event.properties.info, record = object(info) && info.role === "assistant" && this.#owners.get(info.sessionID);
        if (!record || typeof info.id !== "string") return;
        // Marks only. Native updates only its active assistant, and cleanup
        // publishes time.completed while the old Runner is still installed.
        record.assistant = info.id;
        if (typeof info.time?.completed === "number") record.completed = info.id;
      }));
    }
  }

  #report(error) { (this.#options.report || ((cause) => console.error(`sessionbus: ${cause?.message || cause}`)))(error); }
  #background(task) {
    if (this.#work.has(task)) return;
    this.#work.add(task);
    void task.then(() => this.#work.delete(task), (error) => { this.#work.delete(task); this.#report(error); });
  }
  #check(record) {
    if (this.#controller.signal.aborted || record.controller.signal.aborted || this.#owners.get(record.id) !== record) throw record.controller.signal.reason || this.#controller.signal.reason || new Error("native owner retired");
  }
  #identity(record) {
    const info = record.info;
    const identity = { product: `${nativeProduct.product}-peer`, session_id: record.id, groups: [...this.#binding.groups], info: { cwd: info.directory }, ...(info.title ? { name: info.title } : {}) };
    if (!validate("SessionHelloRequest", { protocol: 1, ...identity })) throw Object.assign(new Error("native title is outside the Sessionbus identity grammar"), { code: `${nativeProduct.product.toUpperCase()}_IDENTITY` });
    return identity;
  }

  #native(record, method, parameters, signal = record.controller.signal, submitted) {
    try { this.#check(record); } catch (error) { return Promise.reject(error); }
    if (this.#http.size >= ownerLimits.http) return Promise.reject(new Error("Sessionbus native HTTP work limit reached"));
    const cancel = AbortSignal.any([signal, record.controller.signal, this.#controller.signal]);
    const task = Promise.resolve().then(async () => {
      this.#check(record);
      if (cancel.aborted) throw cancel.reason;
      // Kilo prompt_async can dismiss pending questions. Check again at the
      // final owned invocation boundary, after all awaited snapshot/GET work.
      // Native offers no atomic check-and-submit operation: a new blocker may
      // still cross this handoff. Never answer/reject a blocker ourselves.
      if (method === "promptAsync" && nativeProduct.blockers && !this.#unblocked(record)) return false;
      submitted?.();
      // The managed launcher selects real native fetch. SDK parsing allocation
      // belongs to native; this bounds concurrent operations, not that parser.
      const [group, operation] = method.includes(".") ? method.split(".") : ["session", method];
      const result = await this.#api.client[group][operation](parameters, { signal: cancel, throwOnError: true, redirect: "error" });
      if (result?.error !== undefined && result.error !== null || result?.response?.status !== (method === "promptAsync" ? 204 : 200)) throw new Error(`${nativeProduct.label} ${method} response was not confirmed`);
      this.#check(record);
      return result.data;
    });
    this.#http.add(task);
    void task.then(() => this.#http.delete(task), () => this.#http.delete(task));
    return task;
  }

  async #get(record, signal) {
    const revision = record.revision;
    const info = nativeInfo(await this.#native(record, "get", { sessionID: record.id }, signal), record.id);
    this.#check(record);
    if (revision === record.revision) record.info = info;
    return record.info;
  }

  async #status(record, signal) {
    const revision = record.statusRevision;
    const data = await this.#native(record, "status", { directory: record.info.directory }, signal);
    if (!object(data)) throw new Error(`${nativeProduct.label} status response is malformed`);
    const status = Object.hasOwn(data, record.id) ? data[record.id]?.type : "idle";
    // Native SessionStatus.list omits idle entries. Events arriving during the
    // query take precedence over its snapshot; no local missing-state default.
    if (!["idle", "busy", "retry"].includes(status)) throw new Error(`${nativeProduct.label} session status is malformed`);
    if (revision === record.statusRevision) record.status = status;
    return record.status;
  }

  #unblocked(record) {
    this.#check(record);
    if (record.checkedBlockers !== record.blockerEpoch || record.status !== "idle") return false;
    // Native reactive maps are only a live recheck, never authoritative initial
    // snapshots. Two token references per owner bound invalidation state.
    for (const type of ["permission", "question"]) {
      const pending = this.#api.state.session[type](record.id);
      if (!Array.isArray(pending)) throw new Error(`${nativeProduct.label} live ${type} state is malformed`);
      if (pending.length) return false;
    }
    return true;
  }

  async #deliveryStatus(record, signal) {
    const status = await this.#status(record, signal);
    if (!nativeProduct.blockers || status !== "idle") return status;
    const epoch = record.blockerEpoch;
    const snapshots = await Promise.all(["permission", "question"].map((type) =>
      this.#native(record, `${type}.list`, { directory: record.info.directory }, signal)));
    this.#check(record);
    for (const pending of snapshots) {
      if (!Array.isArray(pending) || pending.some((request) => !object(request) || !nativeID(request.sessionID))) {
        throw new Error(`${nativeProduct.label} pending blocker snapshot is malformed`);
      }
      if (pending.some((request) => request.sessionID === record.id)) return "busy";
    }
    if (epoch !== record.blockerEpoch) return "busy";
    record.checkedBlockers = epoch;
    return this.#unblocked(record) ? "idle" : "busy";
  }

  // OpenCode's halt publishes idle before cleanup completes its assistant, and
  // its Runner stays installed until a final idle; a prompt stored in between
  // never runs. Input that saw this session busy hands off only on an idle
  // observed after the active assistant's completion. The first busy observation
  // starts a generation; repeated busy observations preserve it until handoff.
  // Idle-time input keeps the plain status path.
  async #terminalStatus(record, signal) {
    const status = await this.#status(record, signal);
    if (status !== "idle") {
      if (!record.terminal) record.terminal = { before: record.assistant,
        assistant: record.assistant !== record.completed ? record.assistant : undefined };
      return status;
    }
    const terminal = record.terminal;
    if (!terminal) return status;
    const observed = record.assistant !== terminal.before ? record.assistant : undefined;
    if (observed === undefined && terminal.assistant === undefined) {
      // No assistant event seen (owner attached mid-step): one bounded snapshot.
      // Only an incomplete assistant guarantees a later completion and idle. A
      // user message or completed assistant cannot be ordered against this
      // idle; handing off then is the documented best-effort limitation.
      const messages = await this.#native(record, "messages", { sessionID: record.id, limit: 1 }, signal);
      if (!Array.isArray(messages) || messages.some((message) => !object(message?.info) || typeof message.info.id !== "string")) {
        throw new Error(`${nativeProduct.label} message snapshot is malformed`);
      }
      const latest = messages.at(-1)?.info;
      terminal.assistant = latest?.role === "assistant" && typeof latest.time?.completed !== "number" ? latest.id : null;
    }
    const assistant = record.assistant !== terminal.before ? record.assistant : observed ?? terminal.assistant;
    if (assistant !== null && record.settled !== assistant) return "busy";
    record.terminal = undefined;
    return record.status;
  }

  #ensure(id) {
    if (!nativeID(id)) throw new Error("invalid native session ID");
    if (this.#controller.signal.aborted) throw this.#controller.signal.reason;
    const existing = this.#owners.get(id);
    if (existing) return existing;
    if (this.#records.size >= ownerLimits.owners || this.#pending >= ownerLimits.establishing) throw new Error("Sessionbus native owner limit reached");
    const record = { id, controller: new AbortController(), gate: new ReadyGate(), revision: 0, statusRevision: 0, ...(nativeProduct.blockers ? { blockerEpoch: {} } : {}) };
    this.#owners.set(id, record);
    this.#records.add(record);
    this.#pending++;
    record.establishing = (async () => {
      try {
        await this.#get(record);
        await this.#status(record);
        this.#check(record);
        record.delivery = new NativeDelivery({ sessionID: id, signal: record.controller.signal, report: (error) => this.#report(error),
          status: (signal) => nativeProduct.blockers ? this.#deliveryStatus(record, signal)
            : nativeProduct.terminalHandoff ? this.#terminalStatus(record, signal) : this.#status(record, signal),
          ...(nativeProduct.blockers ? { maySubmit: () => this.#unblocked(record) } : {}), info: (signal) => this.#get(record, signal),
          submit: (params, signal, submitted) => this.#native(record, "promptAsync", params, signal, submitted),
          reserve: (bytes) => { if (this.#bytes + bytes > deliveryLimits.totalBytes) return false; this.#bytes += bytes; return true; },
          release: (bytes) => { this.#bytes -= bytes; },
        });
        record.peer = new OwnedPeer(this.#identity(record), (signal, message) => record.delivery.enqueue(signal, message), { SESSIONBUS_SOCKET: this.#binding.socket }, this.#options.peer);
        await record.peer.ready(record.controller.signal);
        this.#check(record);
        record.gate.settle(undefined, record);
        this.#refresh(record);
      } catch (error) {
        record.gate.settle(error);
        record.controller.abort(error);
        if (this.#owners.get(id) === record) this.#owners.delete(id);
        await record.peer?.dispose(error);
        await record.delivery?.dispose();
        this.#records.delete(record);
      } finally { this.#pending--; }
    })();
    this.#background(record.establishing);
    return record;
  }

  #refresh(record) {
    if (record.refreshing || record.controller.signal.aborted) return;
    const task = (async () => {
      let revision;
      do {
        this.#check(record);
        revision = record.revision;
        const identity = this.#identity(record);
        await record.peer.rehello(identity.name, identity.info);
      } while (revision !== record.revision);
    })();
    record.refreshing = task;
    const clear = () => { if (record.refreshing === task) record.refreshing = undefined; };
    this.#background(task.then(clear, (error) => {
      clear();
      this.#report(error);
      if (error.code === `${nativeProduct.product.toUpperCase()}_IDENTITY` || record.peer.signal.aborted) return this.#retire(record, error);
      // A transport loss retains the kit's reconnect behavior and desired
      // identity; it never publishes a guessed replacement title.
    }));
  }

  async action(action, args, context) {
    if (context.signal?.aborted) throw context.signal.reason;
    const record = this.#ensure(context.sessionID);
    await record.gate.wait(context.signal);
    this.#check(record);
    return record.peer.action(action, args, context.signal);
  }

  // Busy handoff from the native model-step hook. Only an established owner of
  // this exact native session hands off; otherwise its input stays queued.
  async nativeInput(params, signal) {
    if (!object(params) || !nativeID(params.sessionID) || typeof params.messageID !== "string" || !params.messageID.startsWith("msg_") || Buffer.byteLength(params.messageID) > 256 || /[\s\0]/u.test(params.messageID)) throw new Error("invalid native input request");
    const record = this.#owners.get(params.sessionID);
    const partID = nextPartID(params.after);
    if (!record?.delivery || record.controller.signal.aborted || !partID) return { parts: [] };
    const part = await record.delivery.take(signal, async (text, cancel, started) => {
      const value = { id: partID, sessionID: record.id, messageID: params.messageID, type: "text", text };
      await this.#native(record, "part.update", { sessionID: record.id, messageID: params.messageID, partID, directory: record.info.directory, part: value }, cancel, started);
      return value;
    });
    return { parts: part ? [part] : [] };
  }

  async select(id) {
    // Election is route-only and never transferred after failure. Native tool
    // establishment/subagent creation cannot claim the initial requested name.
    if (!nativeID(id)) throw new Error("invalid native session ID");
    const initial = !this.#named;
    this.#named = true;
    const record = this.#ensure(id);
    await record.gate.wait(this.#controller.signal);
    if (!initial || !this.#binding.name) return;
    const revision = record.revision;
    const info = nativeInfo(await this.#native(record, "update", { sessionID: id, title: this.#binding.name }), id);
    if (info.title !== this.#binding.name) throw new Error(`${nativeProduct.label} did not confirm initial native title`);
    if (revision === record.revision) { record.info = info; record.revision++; }
    this.#refresh(record);
    await record.refreshing;
  }

  async #retire(record, reason) {
    if (this.#owners.get(record.id) === record) this.#owners.delete(record.id);
    record.controller.abort(reason);
    record.gate.settle(reason);
    await record.peer?.dispose(reason);
    await record.establishing;
    await record.delivery?.dispose();
    await Promise.allSettled(record.refreshing ? [record.refreshing] : []);
    this.#records.delete(record);
  }

  dispose(reason = new Error("native TUI disposed")) {
    if (this.#dispose) return this.#dispose;
    this.#controller.abort(reason);
    for (const unsubscribe of this.#unsub.splice(0)) unsubscribe();
    this.#dispose = (async () => {
      await Promise.all([...this.#records].map((record) => this.#retire(record, reason)));
      await Promise.allSettled([...this.#work, ...this.#http]);
    })();
    return this.#dispose;
  }
}

// SPDX-License-Identifier: MIT
import { nativeProduct } from "./profile.mjs";

import path from "node:path";
import { publishEndpoint } from "./readiness.mjs";
import { launchEnvironment, interactiveActivation, claimInteractive } from "./activation.mjs";
import { InteractiveEndpoint } from "./endpoint.mjs";
import { NativeOwners, ownerLimits } from "./owners.mjs";

// Native supplies its own Solid instance. Dynamic import is deferred until a
// validated managed launch; no shipped duplicate Solid or ordinary owner.
export function createTui(environment = launchEnvironment, dependencies = {}) {
  let claimed = false, activation;
  return async function tui(api) {
    // Native toggle-on calls this same loaded function. Reserve before awaits;
    // another function/process must still obtain its own exclusive file claim.
    if (activation) throw Object.assign(new Error("EEXIST: managed TUI ownership is still active or disposing"), { code: "EEXIST" });
    const current = {};
    activation = current;
    let launch;
    try { launch = await interactiveActivation(environment); }
    catch (error) { activation = undefined; throw error; }
    if (!launch) { activation = undefined; return; }
    const lifetime = new AbortController();
    const selections = new Map();
    const report = dependencies.report || ((error) => console.error(`sessionbus: ${error?.message || error}`));
    let owners, endpoint, disposeRoot, disposing, starting, unpublish;
    const check = () => {
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      if (activation !== current) throw new Error("managed TUI activation ended");
    };
    const dispose = () => {
      if (disposing) return disposing;
      lifetime.abort(new Error("native TUI plugin disposed"));
      disposeRoot?.();
      disposing = (async () => {
        // Withdraw existing resources immediately, even if native startup work
        // has not settled. Checks prevent constructing later owners/endpoints.
        const closing = Promise.all([unpublish?.(), endpoint?.dispose(), owners?.dispose()]);
        void closing.catch(() => {});
        await starting?.catch(() => {});
        // Publication may have been in flight when disposal began.
        await unpublish?.();
        await closing;
        await Promise.allSettled([...selections.values()]);
        api.lifecycle.signal.removeEventListener("abort", abort);
        unregister();
        // Failed or incomplete cleanup keeps the reservation. No subsequent
        // activation may overlap it or have its marker removed by this one.
        if (activation === current) activation = undefined;
      })();
      return disposing;
    };
    const abort = () => { void dispose(); };
    const unregister = api.lifecycle.onDispose(dispose);
    api.lifecycle.signal.addEventListener("abort", abort, { once: true });
    if (api.lifecycle.signal.aborted) lifetime.abort(api.lifecycle.signal.reason);
    starting = (async () => {
      check();
      const initial = !claimed;
      if (initial) {
        await claimInteractive(launch);
        claimed = true;
      }
      check();
      const solid = dependencies.solid || await import("solid-js");
      check();
      // The first grant spends create and initial naming, including uncertain
      // startup failure. Toggle-on preserves the native session's current title.
      owners = new NativeOwners(api, initial ? launch : { ...launch, name: "" }, { report });
      endpoint = new InteractiveEndpoint(path.join(launch.directory, "actions.sock"), (action, args, context) => owners.action(action, args, context),
        (params, signal) => owners.nativeInput(params, signal));
      await endpoint.ready();
      check();
      unpublish = await publishEndpoint(launch.directory);
      check();
      solid.createRoot((rootDispose) => {
        disposeRoot = rootDispose;
        let previous;
        solid.createEffect(() => {
          const route = api.route.current;
          const id = route.name === "session" ? route.params?.sessionID : undefined;
          if (!id || id === previous) return;
          previous = id;
          if (selections.has(id)) return;
          if (selections.size >= ownerLimits.owners) { report(new Error("Sessionbus pending route limit reached")); return; }
          const selection = owners.select(id);
          selections.set(id, selection);
          void selection.then(() => selections.delete(id), (error) => { selections.delete(id); report(error); });
        });
      });
      // A launch that selects no session gets one at once, titled with its
      // name, so peers can reach it before anything is typed; showing it
      // selects it like any other. The claim above makes this once per launch.
      if (initial && launch.create && api.route.current?.name !== "session") {
        try {
          const created = await api.client.session.create(launch.name ? { title: launch.name } : {}, { signal: lifetime.signal, throwOnError: true, redirect: "error" });
          check();
          api.route.navigate("session", { sessionID: created.data.id });
        } catch (error) { if (!lifetime.signal.aborted) report(error); }
      }
    })();
    try { await starting; }
    catch (error) { await dispose(); throw error; }
  };
}

export default { id: nativeProduct.packageName, tui: createTui() };

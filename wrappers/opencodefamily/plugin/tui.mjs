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
  return async function tui(api) {
    const launch = await interactiveActivation(environment);
    if (!launch) return;
    const lifetime = new AbortController();
    const selections = new Map();
    const report = dependencies.report || ((error) => console.error(`sessionbus: ${error?.message || error}`));
    let owners, endpoint, disposeRoot, disposing, starting;
    const check = () => { if (lifetime.signal.aborted) throw lifetime.signal.reason; };
    const dispose = () => {
      if (disposing) return disposing;
      lifetime.abort(new Error("native TUI plugin disposed"));
      disposeRoot?.();
      disposing = (async () => {
        await starting?.catch(() => {});
        // Endpoint waits Caller tasks; owner cancellation must run concurrently
        // so native GET/hello/delivery held behind those calls can settle.
        await Promise.all([endpoint?.dispose(), owners?.dispose()]);
        await Promise.allSettled([...selections.values()]);
        api.lifecycle.signal.removeEventListener("abort", abort);
        unregister();
      })();
      return disposing;
    };
    const abort = () => { void dispose(); };
    const unregister = api.lifecycle.onDispose(dispose);
    api.lifecycle.signal.addEventListener("abort", abort, { once: true });
    if (api.lifecycle.signal.aborted) lifetime.abort(api.lifecycle.signal.reason);
    starting = (async () => {
      check();
      await claimInteractive(launch);
      check();
      const solid = dependencies.solid || await import("solid-js");
      check();
      owners = new NativeOwners(api, launch, { report });
      endpoint = new InteractiveEndpoint(path.join(launch.directory, "actions.sock"), (action, args, context) => owners.action(action, args, context),
        (params, signal) => owners.nativeInput(params, signal));
      await endpoint.ready();
      check();
      await publishEndpoint(launch.directory);
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
    })();
    try { await starting; }
    catch (error) { await dispose(); throw error; }
  };
}

export default { id: nativeProduct.packageName, tui: createTui() };

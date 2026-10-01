// SPDX-License-Identifier: MIT
import { contract } from "./contract.mjs";

const launchEnv = "SESSIONBUS_OPENCODE_LAUNCH";

// Active only in the TUI process opencode-peer exec'd: the launch names its own
// PID, which children of the shared native service never have. Every session
// this TUI shows is activated in its directory's server instance. While the TUI
// stays open, native `location.shutdown` (the directory was unloaded) and
// `server.connected` (reconnect) each trigger one activation attempt for the
// affected sessions. A failure is reported; an unavailable service or location
// waits for the next native event, and any other failure ends that session's
// activation. Nothing is retried on a timer or in a loop.
export function createTui(environment = process.env, dependencies = {}) {
  return async function setup(context) {
    let launch;
    try { launch = JSON.parse(environment[launchEnv] ?? "null"); } catch { return; }
    if (!launch || launch.pid !== process.pid) return;
    // Native supplies Solid to TUI plugins; imported only once active.
    const { createEffect, createRoot } = dependencies.solid || await import("solid-js");
    const sessions = new Map();
    let name = launch.name || undefined;
    let closed = false;
    const activate = (sessionID, title) => {
      const location = sessions.get(sessionID);
      void (async () => {
        if (title) await context.client.session.update({ sessionID, title });
        if (closed) return;
        await context.client.rpc(contract).activate({ sessionID, socket: launch.socket, groups: launch.groups, ...(title ? { name: title } : {}) }, { location });
      })().catch((error) => {
        if (closed) return;
        const waits = error?.type === undefined || error.type === "rpc.unavailable";
        if (!waits) sessions.delete(sessionID);
        context.ui.toast.show({ variant: "error", message: `Sessionbus: ${error?.message || error}` });
      });
    };
    const disposeRoute = createRoot((dispose) => {
      createEffect(() => {
        const route = context.ui.router.current();
        if (closed || route.type !== "session" || sessions.has(route.sessionID)) return;
        const shown = context.data.session.get(route.sessionID)?.location ?? context.location;
        if (!shown?.directory) return;
        sessions.set(route.sessionID, shown);
        const title = name;
        name = undefined;
        activate(route.sessionID, title);
      });
      return dispose;
    });
    const stopShutdown = context.data.on("location.shutdown", (event) => {
      if (closed || !event.location) return;
      for (const [sessionID, location] of sessions) {
        if (location.directory === event.location.directory && (location.workspaceID ?? undefined) === (event.location.workspaceID ?? undefined)) activate(sessionID);
      }
    });
    const stopConnected = context.data.on("server.connected", () => {
      if (closed) return;
      for (const sessionID of sessions.keys()) activate(sessionID);
    });
    return () => {
      closed = true;
      stopShutdown();
      stopConnected();
      disposeRoute();
    };
  };
}

export default { id: "sessionbus", setup: createTui() };

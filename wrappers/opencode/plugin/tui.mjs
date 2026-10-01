// SPDX-License-Identifier: MIT
import { contract } from "./contract.mjs";

const launchEnv = "SESSIONBUS_OPENCODE_LAUNCH";

// Active only in the TUI process opencode-peer exec'd: the launch names its own
// PID, which children of the shared native service never have. Every session
// this TUI shows is activated in its directory's server instance. While the TUI
// stays open, native `location.shutdown` (the directory was unloaded) and
// `server.connected` (reconnect) each trigger one activation attempt for the
// affected sessions. A session native shows before creating it on the service
// (a --prompt session is mounted optimistically) is activated once native
// announces `session.created` for it. A failure is reported; an unavailable
// service or location waits for the next native event, and any other failure
// ends that session's activation. Nothing is retried on a timer or in a loop.
export function createTui(environment = process.env, dependencies = {}) {
  return async function setup(context) {
    let launch;
    try { launch = JSON.parse(environment[launchEnv] ?? "null"); } catch { return; }
    if (!launch || launch.pid !== process.pid) return;
    // Native supplies Solid to TUI plugins; imported only once active.
    const { createEffect, createRoot } = dependencies.solid || await import("solid-js");
    const sessions = new Map();
    // Shown sessions native has not created yet, with the name still to give.
    const pending = new Map();
    let name = launch.name || undefined;
    let closed = false;
    const activate = (sessionID, title) => {
      const location = sessions.get(sessionID);
      void (async () => {
        await context.client.session.get({ sessionID });
        if (title) await context.client.session.update({ sessionID, title });
        if (closed) return;
        await context.client.rpc(contract).activate({ sessionID, socket: launch.socket, groups: launch.groups, ...(title ? { name: title } : {}) }, { location });
      })().catch((error) => {
        if (closed) return;
        if (error?._tag === "SessionNotFoundError") {
          // A later attempt without the name (a reconnect) keeps it.
          pending.set(sessionID, title ?? pending.get(sessionID));
          return;
        }
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
      // A launch that selects no session gets one, so it is reachable while it
      // waits; showing it activates it like any other. Native syncs the TUI's
      // location from the service after connecting, so this waits for it.
      let created = !launch.create;
      createEffect(() => {
        const directory = context.location?.directory;
        if (closed || created || !directory) return;
        created = true;
        void (async () => {
          const session = await context.client.session.create({ ...(name ? { title: name } : {}), location: { directory } });
          if (!closed) context.ui.router.navigate({ type: "session", sessionID: session.id });
        })().catch((error) => {
          if (!closed) context.ui.toast.show({ variant: "error", message: `Sessionbus: ${error?.message || error}` });
        });
      });
      return dispose;
    });
    const stopShutdown = context.data.on("location.shutdown", (event) => {
      if (closed || !event.location) return;
      for (const [sessionID, location] of sessions) {
        if (location.directory === event.location.directory && (location.workspaceID ?? undefined) === (event.location.workspaceID ?? undefined)) activate(sessionID);
      }
    });
    const stopCreated = context.data.on("session.created", (event) => {
      const sessionID = event?.data?.sessionID;
      if (closed || !pending.has(sessionID)) return;
      const title = pending.get(sessionID);
      pending.delete(sessionID);
      activate(sessionID, title);
    });
    const stopConnected = context.data.on("server.connected", () => {
      if (closed) return;
      for (const sessionID of sessions.keys()) activate(sessionID);
    });
    return () => {
      closed = true;
      stopShutdown();
      stopCreated();
      stopConnected();
      disposeRoute();
    };
  };
}

export default { id: "sessionbus", setup: createTui() };

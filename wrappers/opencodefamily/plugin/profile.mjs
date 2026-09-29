// SPDX-License-Identifier: MIT
import manifest from "./package.json" with { type: "json" };

// Fixed shipped products, selected by the package's own immutable build input.
// This is not a user-configurable dialect or an extra installed runtime package.
const profiles = Object.freeze({
  "@sessionbus/opencode": Object.freeze({ product: "opencode", label: "OpenCode", packageName: "@sessionbus/opencode", launchEnv: "SESSIONBUS_OPENCODE_LAUNCH", metadataKey: "sessionbus.opencode", blockers: false, nativeMessageID: false, terminalHandoff: true }),
  "@sessionbus/kilo": Object.freeze({ product: "kilo", label: "Kilo", packageName: "@sessionbus/kilo", launchEnv: "SESSIONBUS_KILO_LAUNCH", metadataKey: "sessionbus.kilo", blockers: true, nativeMessageID: true, terminalHandoff: false }),
});
export const nativeProduct = profiles[manifest.name];
if (!nativeProduct) throw new Error("unsupported Sessionbus native plugin package");

// SPDX-License-Identifier: MIT
import { nativeProduct } from "./profile.mjs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

// Capture once per native module instance before native tools inherit the
// environment. The server Worker and TUI are separate native runtime contexts.
export const launchEnvironment = Object.freeze(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("SESSIONBUS_"))));
for (const key of Object.keys(launchEnvironment)) delete process.env[key];

export async function interactiveActivation(environment, parent = process.ppid) {
  const raw = environment[nativeProduct.launchEnv];
  if (!raw) return null;
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 64*1024) throw new Error(`invalid managed ${nativeProduct.label} launch metadata`);
  const launch = JSON.parse(raw);
  if (!launch || typeof launch !== "object" || Array.isArray(launch) || Object.keys(launch).length !== (Object.hasOwn(launch, "create") ? 6 : 5) || (Object.hasOwn(launch, "create") && launch.create !== true) || !Number.isSafeInteger(launch.pid) || launch.pid <= 1 || typeof launch.directory !== "string" || !path.isAbsolute(launch.directory) || typeof launch.socket !== "string" || !path.isAbsolute(launch.socket) || typeof launch.name !== "string" || !Array.isArray(launch.groups) || launch.groups.some((value) => typeof value !== "string" || !value.length) || new Set(launch.groups).size !== launch.groups.length) throw new Error(`invalid managed ${nativeProduct.label} launch metadata`);
  // An inherited marker in a nested native invocation is not activation. This
  // deliberately supports the direct native executable, not a guessed shim tree.
  if (launch.pid !== parent) return null;
  const directory = await lstat(launch.directory);
  if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700 || directory.uid !== process.getuid()) throw new Error(`managed ${nativeProduct.label} launch directory is not private and owned`);
  return Object.freeze({ ...launch, groups: Object.freeze([...launch.groups]) });
}

export async function claimInteractive(launch) {
  const claim = await open(path.join(launch.directory, "owner.claim"), "wx", 0o600);
  await claim.close();
  // Never removed/transferred by a helper, even after failed first ownership.
}

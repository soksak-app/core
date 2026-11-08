// Selects the platform facilities that the owner tests of the window checks need beyond injected data: fault injection into the
// file watcher backend of the system and live sampling of processes. Importing this file never depends on the operating system;
// a facility that the selected platform does not provide rejects with PlatformOperationNotImplemented
// (`<operation> is not implemented on <platform>`) when a test asks for it, so such a test fails by name on that platform.
import { PlatformOperationNotImplemented } from "../../../../scripts/platform/platform.js";

const implementations = new Map([["darwin", () => import("./darwin/darwin.mjs")]]);

async function implementation(operation, platform) {
  const load = implementations.get(platform);
  const selected = load === undefined ? undefined : (await load())[operation];
  if (typeof selected !== "function") throw new PlatformOperationNotImplemented(operation, platform);
  return selected;
}

/**
 * The environment of a child process whose file watcher backend runs the fault injection `name` (a source of the platform folder
 * of these tests), built into `folder`.
 */
export async function watcherFaultEnvironment(name, folder, { platform = process.platform } = {}) {
  return (await implementation("watcherFaultEnvironment", platform))(name, folder);
}

/** The live process sampling of the system that stall-sample.mjs runs; resolves when the system provides it. */
export async function liveProcessSampling({ platform = process.platform } = {}) {
  return (await implementation("liveProcessSampling", platform))();
}

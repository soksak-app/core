// The macOS implementation of the platform operations of platform.mjs. The selector loads this module only when an operation runs
// for the platform `darwin`. The published application zip holds the bundle `soksak.app` (docs/spec/hosts.md).
import { join } from "node:path";

/** The bundle of an application zip extracted into `folder`. */
export function applicationBundle(folder) {
  return join(folder, "soksak.app");
}

/** The application and the command line `sok` of the bundle `bundle`, both in its Contents/MacOS. */
export function applicationExecutables(bundle, host) {
  const folder = join(bundle, "Contents", "MacOS");
  return { application: join(folder, `sok-${host}`), sok: join(folder, "sok") };
}

/** Extracts `zip` with ditto, as the application update does. */
export async function extractApplication(zip, folder, run) {
  await run("ditto", ["-x", "-k", zip, folder]);
}

/** The quit item of the application menu has the key equivalent Command+Q, which host.menu writes as `cmd+q`. */
export function quitKeys() {
  return { menu: "cmd+q", key: { key: "q", text: "q", modifiers: ["command"] } };
}

/** lockf(1) takes the lock once no process holds it and runs `true`; a lock held after `seconds` ends it with another status. */
export async function waitForLockRelease(lock, seconds, run) {
  await run("lockf", ["-s", "-t", String(seconds), lock, "true"]);
}

/** The processes of `ps -axo pid=,command=`, one `<pid> <command>` line each. */
export async function listProcesses(run) {
  const listing = await run("ps", ["-axo", "pid=,command="]);
  return listing.split("\n").map((line) => line.trim()).filter((line) => line !== "").map((line) => {
    const match = /^(\d+)\s+(.*)$/.exec(line);
    if (match === null) throw new Error(`ps printed the line ${JSON.stringify(line)}, which names no process`);
    return { pid: Number(match[1]), command: match[2] };
  });
}

// Selects the platform operations of `sok-test-app` (docs/spec/plugins.md#window-checks-of-a-plugin). Each operation is named by its
// intent and returns platform-neutral values; how a platform performs it lives in the implementation of that platform beside this file,
// which the selector loads only when an operation runs for that platform. Importing this file therefore never depends on the
// operating system, and an operation that the selected platform does not implement rejects with PlatformOperationNotImplemented when
// it is called, never at import and never with a substitute result. An operation that runs a program takes `run(file, args)`, which
// resolves with the standard output of the program and bounds it.

/** The error of an operation that the selected platform does not implement: `<operation> is not implemented on <platform>`. */
export class PlatformOperationNotImplemented extends Error {
  constructor(operation, platform) {
    super(`${operation} is not implemented on ${platform}`);
    this.name = "PlatformOperationNotImplemented";
    this.operation = operation;
    this.platform = platform;
  }
}

const implementations = new Map([["darwin", () => import("./darwin.mjs")]]);
const releaseSystems = new Map([["darwin", "darwin"], ["linux", "linux"], ["win32", "windows"]]);
const releaseArchitectures = new Set(["arm64", "x64"]);

/** The implementation of `operation` on `platform`; a platform without it rejects with the named error. */
async function implementation(operation, platform) {
  const load = implementations.get(platform);
  const selected = load === undefined ? undefined : (await load())[operation];
  if (typeof selected !== "function") throw new PlatformOperationNotImplemented(operation, platform);
  return selected;
}

/** The operating system of the computer that runs the run, as Node names it; the default platform of every operation. */
export const runPlatform = () => process.platform;

/** The release platform `<system>-<arch>` of the computer that runs the run, which names the published application zips. */
export function releasePlatform({ platform = runPlatform(), arch = process.arch } = {}) {
  const system = releaseSystems.get(platform);
  if (system === undefined || !releaseArchitectures.has(arch)) throw new Error(`no release platform for ${platform}-${arch}`);
  return `${system}-${arch}`;
}

/** The path of the application that an application zip extracted into `folder` holds. */
export async function applicationBundle(folder, { platform = runPlatform() } = {}) {
  return (await implementation("applicationBundle", platform))(folder);
}

/** The executables of the application `application` of `host`: `{application, sok}`. */
export async function applicationExecutables(application, host, { platform = runPlatform() } = {}) {
  return (await implementation("applicationExecutables", platform))(application, host);
}

/** Extracts the application zip `zip` into the new folder `folder`. */
export async function extractApplication(zip, folder, { platform = runPlatform(), run } = {}) {
  return (await implementation("extractApplication", platform))(zip, folder, run);
}

/**
 * The quit keys of the platform: `menu`, the key equivalent of the quit item of the application menu as host.menu writes it, and
 * `key`, the `{key, text, modifiers}` of the quit key that `sok input key` sends.
 */
export async function quitKeys({ platform = runPlatform() } = {}) {
  return (await implementation("quitKeys", platform))();
}

/** Resolves once no process holds the lock file `lock`; a lock still held after `seconds` rejects. */
export async function waitForLockRelease(lock, seconds, { platform = runPlatform(), run } = {}) {
  return (await implementation("waitForLockRelease", platform))(lock, seconds, run);
}

/** Every process of the system as `{pid, command}` records; `command` is the command line as one text. */
export async function listProcesses({ platform = runPlatform(), run } = {}) {
  return (await implementation("listProcesses", platform))(run);
}

// Selects the platform operations of the verification scripts. Each operation is named by its intent and returns platform-neutral
// values; how a platform performs it lives in the implementation of that platform (scripts/platform/<platform>/), which the selector
// loads only when an operation runs for that platform. Importing this file therefore never depends on the operating system, and an
// operation that the selected platform does not implement rejects with PlatformOperationNotImplemented when it is called, never at
// import and never with a substitute result.

/** The error of an operation that the selected platform does not implement: `<operation> is not implemented on <platform>`. */
export class PlatformOperationNotImplemented extends Error {
  constructor(operation, platform) {
    super(`${operation} is not implemented on ${platform}`);
    this.name = 'PlatformOperationNotImplemented';
    this.operation = operation;
    this.platform = platform;
  }
}

const implementations = new Map([
  ['darwin', () => import('./darwin/darwin.mjs')],
  ['linux', () => import('./linux/linux.mjs')],
]);
const releaseSystems = new Map([['darwin', 'darwin'], ['linux', 'linux'], ['win32', 'windows']]);
const releaseArchitectures = new Set(['arm64', 'x64']);

/** The implementation of `operation` on `platform`; a platform without it rejects with the named error. */
async function implementation(operation, platform) {
  const load = implementations.get(platform);
  const selected = load === undefined ? undefined : (await load())[operation];
  if (typeof selected !== 'function') throw new PlatformOperationNotImplemented(operation, platform);
  return selected;
}

/** Metadata uses the runtime key that selects a sidecar release; it does not require live process lookup. */
export function releasePlatform({ platform = process.platform, arch = process.arch } = {}) {
  const os = releaseSystems.get(platform);
  if (!os || !releaseArchitectures.has(arch)) throw new Error(`sidecar release platform unavailable on ${platform}-${arch}`);
  return `${os}-${arch}`;
}

/** The registry key of the core release of `app` on the declared platform, `<platform>-<host>` (docs/spec/installation.md). */
export function releaseKey(app, { platform = process.platform, arch = process.arch } = {}) {
  return `${releasePlatform({ platform, arch })}-${app}`;
}

/** The path of the declared application artifact of `app` in the build output `folder` (for example `<target>/debug`). */
export async function applicationArtifact(folder, app, { platform = process.platform } = {}) {
  return (await implementation('applicationArtifact', platform))(folder, app);
}

/** The executables of the declared application artifact `artifact` of `app`: `{application, sok}`. */
export async function applicationExecutables(artifact, app, { platform = process.platform } = {}) {
  return (await implementation('applicationExecutables', platform))(artifact, app);
}

/**
 * Asks the application of the endpoint `client` to quit as a person does: `by` `menu` through the quit item of its menu, `by` `key`
 * through the quit key of the platform. Resolves with the name of the action once the application accepted the request.
 */
export async function quitApplication(client, by, { platform = process.platform } = {}) {
  if (by !== 'menu' && by !== 'key') throw new Error(`unknown quit path ${JSON.stringify(by)}`);
  return (await implementation('quitApplication', platform))(client, by);
}

/**
 * Opens the running application whose executable is `executable` through the application launcher of the system as a person does,
 * which activates it. Resolves once the launcher accepted the request.
 */
export async function openApplication(executable, { platform = process.platform } = {}) {
  return (await implementation('openApplication', platform))(executable);
}

/** Resolves with true once no process holds the lock file `lock`, and with false when `seconds` pass first. */
export async function waitForLockRelease(lock, seconds, { platform = process.platform } = {}) {
  return (await implementation('waitForLockRelease', platform))(lock, seconds);
}

/** Every process of the system as `{pid, ppid, executable, arguments}` records; `arguments` is the command line as one text. */
export async function listProcesses({ platform = process.platform } = {}) {
  return (await implementation('listProcesses', platform))();
}

/**
 * Runs the native end-to-end tests `target` of the platform's native library from the checkout `cwd` with `env`, with their output
 * on the output of the run. Resolves when they pass; an abort of `signal` ends them.
 */
export async function runNativeTests(target, { platform = process.platform, cwd, env, signal } = {}) {
  return (await implementation('runNativeTests', platform))(target, { cwd, env, signal });
}

/** The crash reports that the system wrote for `app` since `since` (ms), as `{report, fault}` records. */
export async function crashReports(app, since, { platform = process.platform, ...options } = {}) {
  return (await implementation('crashReports', platform))(app, since, options);
}

/** Reads the executable the kernel associates with the live PID. */
export async function processExecutable(pid, { platform = process.platform, ...options } = {}) {
  return (await implementation('processExecutable', platform))(pid, options);
}

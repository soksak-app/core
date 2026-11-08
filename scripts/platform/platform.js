// Selects platform operations without loading a native implementation until that operation is requested.
//
// Each operation is an explicit contract. Importing this file never depends on the running operating system: an operation that the
// selected platform does not implement throws PlatformOperationNotImplemented when it is called, never at import, and never with a
// substitute result.
import * as darwinArtifacts from './darwin/artifacts.mjs';
import * as darwinEndToEnd from './darwin/end-to-end.mjs';

/** The error of an operation that the selected platform does not implement: `<operation> is not implemented on <platform>`. */
export class PlatformOperationNotImplemented extends Error {
  constructor(operation, platform) {
    super(`${operation} is not implemented on ${platform}`);
    this.name = 'PlatformOperationNotImplemented';
    this.operation = operation;
    this.platform = platform;
  }
}

const processReaders = new Map([
  ['darwin', () => import('./darwin/process-executable.mjs')],
  ['linux', () => import('./linux/process-executable.mjs')],
]);
const artifactLayouts = new Map([['darwin', darwinArtifacts]]);
const endToEndOperations = new Map([['darwin', darwinEndToEnd]]);
const releaseSystems = new Map([['darwin', 'darwin'], ['linux', 'linux'], ['win32', 'windows']]);
const releaseArchitectures = new Set(['arm64', 'x64']);

/** The implementation of `operation` in `table` for `platform`; a platform without it throws the named error. */
function select(table, operation, platform, member) {
  const implementation = table.get(platform);
  if (implementation === undefined || (member !== undefined && typeof implementation[member] !== 'function')) {
    throw new PlatformOperationNotImplemented(operation, platform);
  }
  return member === undefined ? implementation : implementation[member];
}

/** Metadata uses the runtime key that selects a sidecar release; it does not require live process lookup. */
export function releasePlatform({ platform = process.platform, arch = process.arch } = {}) {
  const os = releaseSystems.get(platform);
  if (!os || !releaseArchitectures.has(arch)) throw new Error(`sidecar release platform unavailable on ${platform}-${arch}`);
  return `${os}-${arch}`;
}

/** The registry key of the core release of `app` on the platform, `<platform>-<host>` (docs/spec/installation.md). */
export function releaseKey(app, { platform = process.platform, arch = process.arch } = {}) {
  return `${releasePlatform({ platform, arch })}-${app}`;
}

/** The declared artifact of application `app` in the build output `folder` (for example `<target>/debug`). */
export function applicationBundle(folder, app, { platform = process.platform } = {}) {
  return select(artifactLayouts, 'application artifact', platform, 'applicationBundle')(folder, app);
}

/** The executables of the declared application artifact `bundle`: `{ application, installer }` (the bundled `sok`). */
export function artifactExecutables(bundle, app, { platform = process.platform } = {}) {
  return select(artifactLayouts, 'application artifact executables', platform, 'artifactExecutables')(bundle, app);
}

/** The keyboard shortcut and menu key equivalent of the Quit item of the application menu. */
export function quitShortcut({ platform = process.platform } = {}) {
  return select(endToEndOperations, 'quit shortcut', platform, 'quitShortcut')();
}

/** The command that runs the native end-to-end target `target` of the platform's native library. */
export function nativeEndToEndCommand(target, { platform = process.platform } = {}) {
  return select(endToEndOperations, 'native end-to-end tests', platform, 'nativeEndToEndCommand')(target);
}

/** The command that ends with status 0 once no process holds the lock file `lock`, within `seconds`. */
export function lockReleaseCommand(lock, seconds, { platform = process.platform } = {}) {
  return select(endToEndOperations, 'lock release wait', platform, 'lockReleaseCommand')(lock, seconds);
}

/** The command whose output lists every process as `<pid> <command>` lines. */
export function processTableCommand({ platform = process.platform } = {}) {
  return select(endToEndOperations, 'process table', platform, 'processTableCommand')();
}

/** The system crash reports of application `app` written since `since` (ms), each line naming its file and fault. */
export function crashReports(app, since, { platform = process.platform, ...options } = {}) {
  return select(endToEndOperations, 'crash reports', platform, 'crashReports')(app, since, options);
}

/** Reads the executable the kernel associates with the live PID. */
export async function processExecutable(pid, { platform = process.platform, ...options } = {}) {
  const load = select(processReaders, 'process executable identity', platform);
  const implementation = await load();
  return implementation.processExecutable(pid, options);
}

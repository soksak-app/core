// Selects evidence operations without loading a native implementation until that operation is requested.
const processReaders = new Map([
  ['darwin', () => import('./darwin/process-executable.mjs')],
]);
const releaseSystems = new Map([['darwin', 'darwin'], ['linux', 'linux'], ['win32', 'windows']]);
const releaseArchitectures = new Set(['arm64', 'x64']);

/** Metadata uses the runtime key that selects a sidecar release; it does not require live process lookup. */
export function releasePlatform({ platform = process.platform, arch = process.arch } = {}) {
  const os = releaseSystems.get(platform);
  if (!os || !releaseArchitectures.has(arch)) throw new Error(`sidecar release platform unavailable on ${platform}-${arch}`);
  return `${os}-${arch}`;
}

/** Unsupported platforms fail at the operation boundary, so metadata-only consumers remain importable. */
export async function processExecutable(pid, { platform = process.platform, ...options } = {}) {
  const load = processReaders.get(platform);
  if (!load) throw new Error(`process executable identity unavailable on ${platform}`);
  const implementation = await load();
  return implementation.processExecutable(pid, options);
}

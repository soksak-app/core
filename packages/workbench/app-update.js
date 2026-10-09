// The application update state and operation of the window (docs/spec/installation.md#application-update).
import { compareVersions, satisfies } from "./version-range.js";

/**
 * The page of a published release for the URL of its file, `<repository>/releases/download/<tag>/<file>`; null for any
 * other URL, which names no page.
 */
export function releasePage(url) {
  const match = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/releases\/download\/([^/]+)\/[^/]+$/.exec(url);
  return match ? `${match[1]}/releases/tag/${match[2]}` : null;
}

/**
/**
 * The installed plugins whose `engines.soksak` does not contain the candidate version, by id, each with the newest
 * version of the plugin that does and is not revoked, or null. A plugin whose installed version the index does not list
 * is not judged. `pluginsState` is the host's plugin state, or null before it was read.
 */
function incompatiblePlugins(pluginsState, candidate) {
  if (!pluginsState?.index?.plugins || !pluginsState.installed) return [];
  const revoked = pluginsState.index.revoked.plugins;
  const found = [];
  for (const [id, record] of Object.entries(pluginsState.installed.plugins)) {
    const entry = pluginsState.index.plugins.find((plugin) => plugin.id === id);
    const installed = entry?.versions.find((item) => item.version === record.version);
    if (!installed || satisfies(installed.engines.soksak, candidate)) continue;
    const fits = entry.versions
      .filter((item) => satisfies(item.engines.soksak, candidate) && !revoked.some((r) => r.id === id && r.version === item.version))
      .map((item) => item.version)
      .sort(compareVersions);
    found.push({ id, installed: record.version, range: installed.engines.soksak, compatible: fits.length ? fits.at(-1) : null });
  }
  return found.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * The application update of this window. `host` is null without the application host. `plugins` returns the plugin
 * state of the host or null. `changed` is called whenever the state or the operation changes.
 */
export function createAppUpdate({ host, plugins = () => null, changed }) {
  let state = null;
  let failure = null;
  let operation = null;

  /** Reads the candidate of the registry index again. A read that fails is the error of the status. */
  async function refresh() {
    if (!host) return;
    try {
      state = await host.call("appUpdateState");
      failure = null;
    } catch (error) {
      state = null;
      failure = error.message;
    } finally {
      changed();
    }
  }

  /** Stages the candidate, then applies the staged bundle, which quits the application. */
  async function update() {
    if (!host) throw new Error("the application update needs a native host");
    if (!state?.available) throw new Error("no application update is available");
    const { version } = state.available;
    operation = { state: "staging", version, error: null };
    changed();
    try {
      const { bundle } = await host.call("appUpdateStage", { version });
      operation = { state: "applying", version, error: null };
      changed();
      await host.call("appUpdateApply", { bundle });
    } catch (error) {
      operation = { state: "failed", version, error: error.message };
      changed();
      throw error;
    }
  }

  /** Opens the release page of the candidate in the default application of the person. */
  async function openRelease() {
    if (!host) throw new Error("the application update needs a native host");
    const url = status().available?.release;
    if (!url) throw new Error("the application update has no release page");
    await host.call("linkOpen", { url });
  }

  /** The value of the core.app status. */
  function status() {
    return {
      // default: before the first read, and after a read that failed, the version is null (core.app).
      version: state?.version ?? null,
      available: state?.available ? { version: state.available.version, release: releasePage(state.available.release.url) } : null,
      operation,
      error: failure,
      incompatible: state?.available ? incompatiblePlugins(plugins(), state.available.version) : [],
    };
  }

  return { refresh, update, openRelease, status };
}

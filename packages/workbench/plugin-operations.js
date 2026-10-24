// Operations on installed plugins and the core.plugins status (Plugin screen in docs/spec/installation.md and plugin
// operations inside the application). The host provides pluginsState and pluginsRun;
// without a host, only the plugins that the window loaded are shown and there are no operations.

import { beginOperation } from "./operations.js";
import { compareVersions } from "./version-range.js";
import { compositionKindOf } from "./surface-composition-kind.js";

export const PLUGIN_ACTIONS = ["install", "update", "remove", "enable", "disable"];

/**
 * Builds the sidecars that a plugin names as {name, range, version} in name order. For an installed plugin it uses the range of the installed.json
 * entry and the installed sidecar version; otherwise the range of the newest registry version; otherwise the dependencies of the loaded manifest.
 */
function sidecarsOf(record, entry, unit, state) {
  let ranges;
  if (record) ranges = Object.entries(record.sidecars);
  else if (entry?.versions.length) ranges = Object.entries(entry.versions.toSorted((a, b) => compareVersions(a.version, b.version)).at(-1).sidecars);
  else ranges = Object.entries(unit.dependencies);
  return ranges.sort(([a], [b]) => a.localeCompare(b)).map(([name, range]) => ({
    name, range,
    // default: a sidecar without host state or not installed has an unknown version (null).
    version: state?.installed.sidecars[name]?.version ?? null,
  }));
}

/** The registry index lists a version of the installed plugin of row that is newer than the installed version. */
export function hasUpdate(row) {
  return row.installed !== null && row.latest !== null && compareVersions(row.latest, row.installed.version) > 0;
}

/**
 * Builds the list rows in id order. loaded holds the manifests of the plugins that the window loaded;
 * state is the result of pluginsState of the host, and null if there is no host.
 */
export function pluginRows(loaded, state) {
  const byId = new Map(loaded.map((unit) => [unit.id, unit]));
  if (!state) {
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).map((unit) => ({
      id: unit.id, name: unit.name, description: unit.description, state: "loaded", installed: null, latest: null,
      composition: compositionKindOf(unit.surface),
      sidecars: sidecarsOf(null, null, unit, null),
    }));
  }
  const installed = state.installed.plugins;
  // If the index is absent or could not be read, there are no registry plugins. A revoked version is withdrawn, so the
  // entry keeps only the versions that are not revoked (docs/spec/installation.md#version-selection).
  const listed = Array.isArray(state.index?.plugins);
  const revoked = listed ? state.index.revoked.plugins : [];
  const indexed = new Map(listed ? state.index.plugins.map((entry) => [entry.id, {
    ...entry, versions: entry.versions.filter((item) => !revoked.some((r) => r.id === entry.id && r.version === item.version)),
  }]) : []);
  // A plugin without a usable version is not offered; an installed or loaded one keeps its row.
  const ids = [...new Set([...byId.keys(), ...Object.keys(installed), ...[...indexed.values()].filter((entry) => entry.versions.length).map((entry) => entry.id)])].sort();
  return ids.map((id) => {
    const unit = byId.get(id);
    const entry = indexed.get(id);
    const record = Object.hasOwn(installed, id) ? installed[id] : null;
    let status;
    if (unit && record && record.enabled && record.version === unit.version) status = "loaded";
    else if (!unit && record && !record.enabled) status = "disabled";
    else if (!unit && !record) status = "available";
    else status = "reload";
    const latest = entry?.versions.length ? entry.versions.map((v) => v.version).sort(compareVersions).at(-1) : null;
    // default: name and description are decided in the order of the loaded manifest, the registry entry, and the plugin id (docs/spec/installation.md).
    const about = unit ?? entry ?? { name: id, description: "" };
    return {
      id, name: about.name, description: about.description, state: status,
      composition: compositionKindOf(unit?.surface),
      installed: record ? { version: record.version, enabled: record.enabled } : null, latest,
      // A plugin that exists only in installed.json also has sidecars in that entry.
      sidecars: sidecarsOf(record, entry, unit, state),
    };
  });
}

/**
 * Plugin operation state. If host is null, it reports only the loaded plugins, without operations. changed is called
 * whenever the state changes.
 */
export function createPluginOperations({ host, loaded, changed }) {
  let state = null;
  // A read failure is {kind, message}. kind is index if the registry index could not be read, or state if the plugin state could not be read.
  let failure = null;
  let operation = null;
  // The outdated persistent services that the host reports: `[{sidecar, running, installed, sessions}]`.
  let outdated = [];

  /** Reads the outdated sidecars of the host again. A read that fails is reported as the error of the state. */
  async function refreshOutdated() {
    if (!host) return;
    try {
      outdated = await host.call("sidecarsOutdated");
    } catch (error) {
      outdated = [];
      // default: an error that is not an Error carries its value as the text.
      failure = { kind: "state", message: String(error?.message ?? error) };
    } finally {
      changed();
    }
  }

  /** Replaces the outdated service of a sidecar, then reads the outdated sidecars again, also after a failure. */
  async function replace(sidecar) {
    if (!host) throw new Error("plugin operations need a native host");
    try {
      await host.call("sidecarsReplace", { sidecar });
    } finally {
      await refreshOutdated();
    }
  }

  /** Reads the state of the host again. If it cannot be read, that error is reported as failure. */
  async function refresh() {
    if (!host) return;
    try {
      state = await host.call("pluginsState");
      failure = state.index && typeof state.index.error === "string" ? { kind: "index", message: state.index.error } : null;
    } catch (error) {
      state = null;
      // default: an error that is not an Error carries its value as the text.
      failure = { kind: "state", message: String(error?.message ?? error) };
    } finally {
      changed();
    }
  }

  /** Runs one operation. It records running before the run and done or failed after it ends. */
  async function runAction(action, plugin) {
    if (!PLUGIN_ACTIONS.includes(action)) throw new Error(`unknown plugin action ${action}`);
    if (!host) throw new Error("plugin operations need a native host");
    operation = { action, plugin, state: "running", error: null };
    changed();
    const cids = beginOperation("page.plugin.operation", { action, plugin });
    try {
      await host.call("pluginsRun", { action, plugin }, { cids });
      operation = { action, plugin, state: "done", error: null };
    } catch (error) {
      // default: an error that is not an Error carries its value as the text.
      operation = { action, plugin, state: "failed", error: String(error?.message ?? error) };
      throw error;
    } finally {
      await refresh();
    }
  }

  /** Updates the plugins of `updates` one after the other and stops at the first failure (docs/spec/installation.md). */
  async function updateAll() {
    if (!host) throw new Error("plugin operations need a native host");
    for (const update of status().updates) await runAction("update", update.id);
  }

  /** Sets the registry index and reads the state again (docs/spec/installation.md). */
  async function useRegistry(index) {
    if (!host) throw new Error("plugin operations need a native host");
    await host.call("pluginsUseRegistry", { index });
    await refresh();
  }

  /** Value of the core.plugins status. */
  function status() {
    const rows = host && !state ? [] : pluginRows(loaded(), state);
    return {
      // default: before the state is read or if it could not be read, there is no registry address (null).
      registry: state?.registry ?? null,
      // default: if there is no read failure, error is null (core.plugins).
      error: failure?.message ?? null,
      plugins: rows,
      operation,
      reload: rows.some((row) => row.state === "reload"),
      updates: rows.filter(hasUpdate).map((row) => ({ id: row.id, installed: row.installed.version, latest: row.latest })),
      outdated,
    };
  }

  /**
   * Starts a durable starter job on the first run or resumes its saved plugin list after an interrupted install. A completed job is not
   * enforced again, so later user removals remain unchanged. The caller reloads the page only when this call installed a plugin.
   */
  async function installStarter(pack, defaultRegistry, log, show) {
    if (!host) return false;
    let job = state?.starter ?? null;
    if (job?.state === "complete") return false;
    if (!job && (pack === null || !state?.firstRun)) return false;
    try {
      if (!job && state.registry === null && defaultRegistry !== null) {
        await useRegistry(defaultRegistry);
        if (state === null) throw new Error(failure.message);
      }
      if (!job && state.registry === null) {
        log(`first run: no registry is set; the starter pack ${pack} was not installed`);
        show(`플러그인 레지스트리가 없어 시작 플러그인 묶음 ${pack}을 설치하지 못했습니다. sok registry use 로 레지스트리를 정한 뒤 다시 시작하세요.`);
        return false;
      }
      if (typeof state.index?.error === "string") throw new Error(state.index.error);
      if (!job) {
        const entry = state.index.packs.find((item) => item.name === pack);
        if (!entry) throw new Error(`the registry has no pack ${pack}`);
        job = { format: 1, state: "pending", pack, registry: state.registry, plugins: [...entry.plugins] };
        await host.call("pluginsStarter", { state: "pending", pack: job.pack, registry: job.registry, plugins: job.plugins });
        await refresh();
        if (state === null) throw new Error(failure.message);
        job = state.starter;
      } else {
        if (job.state !== "pending") throw new Error(`starter job has unknown state ${String(job.state)}`);
        if (state.registry !== job.registry) {
          throw new Error(`starter job registry ${job.registry} differs from current registry ${state.registry}`);
        }
      }
      if (!job || job.state !== "pending") throw new Error("starter job was not recorded as pending");
      let installedAny = false;
      for (const id of job.plugins) {
        if (state.installed?.plugins?.[id]) continue;
        await runAction("install", id);
        installedAny = true;
        if (state === null) throw new Error(failure.message);
        if (!state.installed?.plugins?.[id]) throw new Error(`starter plugin ${id} was not recorded as installed`);
      }
      await host.call("pluginsStarter", { state: "complete", pack: job.pack, registry: job.registry, plugins: job.plugins });
      await refresh();
      if (state === null) throw new Error(failure.message);
      if (state.starter?.state !== "complete") throw new Error("starter job was not recorded as complete");
      return installedAny;
    } catch (error) {
      // default: an error that is not an Error carries its value as the text.
      const failedPack = job?.pack ?? pack;
      log(`first run: the starter pack ${failedPack} was not installed: ${error?.message ?? error}`);
      // default: an error that is not an Error carries its value as the text.
      show(`시작 플러그인 묶음 ${failedPack}을 설치하지 못했습니다 · ${error?.message ?? error}.`);
      return false;
    }
  }

  return { state: () => state, refresh, refreshOutdated, replace, run: runAction, updateAll, useRegistry, status, installStarter, failure: () => failure, hosted: Boolean(host) };
}

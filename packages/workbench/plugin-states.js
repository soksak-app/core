// Mounts the plugin state modules for each project that the window shows (docs/spec/plugins.md#plugin-state).
//
// When the window shows another project or the library, it first releases all state modules and clears their registrations.
import { checkProjectData, createPluginRuntime } from "@soksak/plugin-api";
import { registry } from "./exposure.js";
import { log } from "./host.js";
import { pluginRecords } from "./plugin-records.js";

const states = [];
// The declared project data of each plugin, from its plugin.json data field (docs/spec/plugins.md#project-data).
const declaredData = new Map();
let options = null;
/* The visible project and the mounted state modules. */
let shown = null;
// The visible project {id, root}, or null; it is set with shown.
let shownProject = null;
let mounts = [];
// The project data functions of each plugin for the visible project (dataOf), set while the project is shown.
const dataAccess = new Map();
let turn = Promise.resolve();

const failed = (plugin) => (error) =>
  dispatchEvent(new ErrorEvent("error", { message: `plugin ${plugin} state: ${error.message}` }));

/**
 * Sets the host functions that the state modules use.
 *   sidecar(name)                      {send(surface, body), on(surface, fn), onFailure(surface, fn)}
 *   data.get(project, plugin)          the stored plugin data object
 *   data.set(project, plugin, key, v)  a promise that stores one value
 */
export function configureStates(values) {
  options = values;
}

/** Registers one state module. state is {plugin, module, sidecars, data}. */
export function registerState(state) {
  states.push(state);
}

/** Declares the project data of a plugin, which a state module or a plugin host reads and writes (docs/spec/plugins.md#project-data). */
export function declareProjectData(plugin, data) {
  declaredData.set(plugin, data);
}

// default: format is an optional field of a plugin.json data key and is 1 when absent (docs/spec/plugins.md#project-data).
const formatOf = (entry) => entry.format ?? 1;

/** Whether the stored entry has the current form: an object that has only a positive integer format and value. */
const isEntry = (stored) => stored !== null && typeof stored === "object" && !Array.isArray(stored)
  && Object.keys(stored).sort().join() === "format,value" && Number.isInteger(stored.format) && stored.format > 0;

/**
 * Converts once and stores a declared key that was stored in an earlier form or format. For a key that could not be converted, it keeps the stored value and returns the error to
 * raise when that key is read (docs/spec/plugins.md#project-data).
 */
async function convertData(state, project, module, declared) {
  const failures = new Map();
  const stored = options.data.get(project.id, state.plugin);
  const where = (key) => `project ${project.id} plugin ${state.plugin} data ${key}`;
  for (const [key, entry] of Object.entries(declared)) {
    if (!Object.hasOwn(stored, key)) continue;
    const want = formatOf(entry);
    const current = isEntry(stored[key]);
    const format = current ? stored[key].format : 1;
    if (current && format === want) continue;
    if (format > want) {
      failures.set(key, `${where(key)}: stored format ${format} is newer than declared format ${want}`);
      continue;
    }
    let value = current ? stored[key].value : stored[key];
    if (format < want) {
      if (typeof module.convertData !== "function") {
        failures.set(key, `${where(key)}: stored format ${format} needs convertData to reach format ${want}`);
        continue;
      }
      try {
        value = await module.convertData({ key, format, value: structuredClone(value) });
      } catch (error) {
        failures.set(key, `${where(key)}: converting format ${format} to ${want} failed: ${error.message}`);
        continue;
      }
    }
    try {
      checkProjectData(state.plugin, declared, key, value);
    } catch (error) {
      failures.set(key, error.message);
      continue;
    }
    await options.data.set(project.id, state.plugin, key, { format: want, value });
    log(`plugin data: converted ${where(key)} from ${current ? `format ${format}` : "no format"} to format ${want}`);
  }
  return failures;
}

/**
 * The project data functions of one plugin for one project: get(key) and set(key, value), which the state module context and
 * the plugin host call with the same checks. failures holds the conversion failures of the keys (convertData).
 */
function dataOf(project, plugin, declared, failures) {
  const read = (key) => {
    const stored = options.data.get(project.id, plugin);
    if (!Object.hasOwn(declared, key)) throw new Error(`${plugin} data ${key} is not declared`);
    if (failures.has(key)) throw new Error(failures.get(key));
    if (!Object.hasOwn(stored, key)) return structuredClone(declared[key].default);
    return checkProjectData(plugin, declared, key, stored[key].value);
  };
  const write = async (key, value) => {
    checkProjectData(plugin, declared, key, value);
    await options.data.set(project.id, plugin, key, { format: formatOf(declared[key]), value });
    failures.delete(key);
  };
  return { get: read, set: write };
}

function contextOf(state, project, table, data) {
  const session = `state:${state.plugin}:${project.id}`;
  // The recording functions of a surface runtime, without a surface (docs/spec/plugins.md#plugin-state).
  const { trace, log: eventLog } = createPluginRuntime({ pluginId: state.plugin, hooks: pluginRecords });
  const port = state.sidecars?.length === 1 ? options.sidecar(state.sidecars[0]) : null;
  return {
    project: { id: project.id, root: project.root },
    exposure: { status: table.status, command: table.command },
    runtime: Object.freeze({ trace, log: eventLog }),
    sidecar: {
      send(body) {
        if (!port) throw new Error(`plugin ${state.plugin} state requires exactly one declared sidecar`);
        return port.send(session, body);
      },
      on(fn) {
        if (!port) throw new Error(`plugin ${state.plugin} state requires exactly one declared sidecar`);
        return port.on(session, fn);
      },
      onFailure(fn) {
        if (!port) throw new Error(`plugin ${state.plugin} state requires exactly one declared sidecar`);
        return port.onFailure(session, fn);
      },
    },
    data,
  };
}

async function show(project) {
  // default: the project id of a window without a project is null.
  if ((project?.id ?? null) === shown) return;
  const previous = mounts;
  mounts = [];
  // default: the project id of a window without a project is null.
  shown = project?.id ?? null;
  // default: a window without a project has no shown project object (null).
  shownProject = project ?? null;
  dataAccess.clear();
  for (const { state, table, done } of previous) {
    try {
      await (await done)?.dispose();
    } catch (error) {
      failed(state.plugin)(error);
    }
    table.clear();
  }
  if (!project) return;
  for (const state of states) {
    const table = registry.plugin(state.plugin);
    const done = import(state.module).then(async (module) => {
      if (typeof module.mount !== "function") throw new TypeError(`state module of ${state.plugin} has no mount()`);
      // default: data is an optional field of plugin.json, and when absent there is no project data (docs/spec/plugins.md).
      const declared = state.data ?? {};
      const failures = await convertData(state, project, module, declared);
      const data = dataOf(project, state.plugin, declared, failures);
      dataAccess.set(state.plugin, data);
      const result = await module.mount(contextOf(state, project, table, data));
      if (!result || typeof result.dispose !== "function") throw new TypeError(`state module of ${state.plugin} must return { dispose() }`);
      return result;
    });
    const entry = { state, table, done: done.catch((error) => { failed(state.plugin)(error); return null; }) };
    mounts.push(entry);
    await entry.done;
  }
  // A plugin with project data and no state module has no module to convert with, so its stored values convert with no convertData.
  for (const [plugin, declared] of declaredData) {
    if (dataAccess.has(plugin) || states.some((state) => state.plugin === plugin)) continue;
    const failures = await convertData({ plugin }, project, {}, declared);
    dataAccess.set(plugin, dataOf(project, plugin, declared, failures));
  }
}

/**
 * The project data of a plugin host for the visible project (docs/spec/plugin-host.md#project-data-calls). It waits for the
 * show in progress, then refuses with the named error when no project is shown.
 */
export const pluginHostData = {
  async get(plugin, key) {
    return (await accessOf(plugin)).get(key);
  },
  async set(plugin, key, value) {
    return (await accessOf(plugin)).set(key, value);
  },
};

async function accessOf(plugin) {
  await turn;
  if (shownProject === null) throw new Error(`plugin host ${plugin}: no project is shown`);
  const access = dataAccess.get(plugin);
  if (access !== undefined) return access;
  // A plugin that declares no project data has no key to read, so every key is refused as not declared.
  if (!declaredData.has(plugin)) return dataOf(shownProject, plugin, {}, new Map());
  // A plugin whose state module did not mount has no conversion result for the project.
  throw new Error(`plugin ${plugin} data of project ${shownProject.id} is not loaded: its state module did not mount`);
}

/** Reports the project {id, root} that the window shows, or null. They are handled in the order received. */
export function showStates(project) {
  const done = turn.then(() => show(project));
  turn = done.catch(failed("states"));
  return done;
}

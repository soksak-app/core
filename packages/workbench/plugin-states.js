// Mounts the plugin state modules for each project that the window shows (docs/spec/plugins.md#plugin-state).
//
// When the window shows another project or the library, it first releases all state modules and clears their registrations.
import { checkProjectData } from "@soksak/plugin-api";
import { registry } from "./exposure.js";
import { log } from "./host.js";

const states = [];
let options = null;
/* The visible project id and the mounted state modules. */
let shown = null;
let mounts = [];
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

function contextOf(state, project, table, failures) {
  const session = `state:${state.plugin}:${project.id}`;
  // default: data is an optional field of plugin.json, and when absent there is no project data (docs/spec/plugins.md).
  const declared = state.data ?? {};
  const read = (key) => {
    const stored = options.data.get(project.id, state.plugin);
    if (!Object.hasOwn(declared, key)) throw new Error(`${state.plugin} data ${key} is not declared`);
    if (failures.has(key)) throw new Error(failures.get(key));
    if (!Object.hasOwn(stored, key)) return structuredClone(declared[key].default);
    return checkProjectData(state.plugin, declared, key, stored[key].value);
  };
  const port = state.sidecars?.length === 1 ? options.sidecar(state.sidecars[0]) : null;
  return {
    project: { id: project.id, root: project.root },
    exposure: { status: table.status, command: table.command },
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
    data: {
      get: read,
      set: async (key, value) => {
        checkProjectData(state.plugin, declared, key, value);
        await options.data.set(project.id, state.plugin, key, { format: formatOf(declared[key]), value });
        failures.delete(key);
      },
    },
  };
}

async function show(project) {
  // default: the project id of a window without a project is null.
  if ((project?.id ?? null) === shown) return;
  const previous = mounts;
  mounts = [];
  // default: the project id of a window without a project is null.
  shown = project?.id ?? null;
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
      const result = await module.mount(contextOf(state, project, table, failures));
      if (!result || typeof result.dispose !== "function") throw new TypeError(`state module of ${state.plugin} must return { dispose() }`);
      return result;
    });
    const entry = { state, table, done: done.catch((error) => { failed(state.plugin)(error); return null; }) };
    mounts.push(entry);
    await entry.done;
  }
}

/** Reports the project {id, root} that the window shows, or null. They are handled in the order received. */
export function showStates(project) {
  const done = turn.then(() => show(project));
  turn = done.catch(failed("states"));
  return done;
}

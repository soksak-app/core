// Holds the project data that each plugin declares, for the visible project (docs/spec/plugins.md#project-data).
//
// A plugin host reads and writes its declared keys through pluginHostData. When the window shows another project or the library,
// the values of the previous project are no longer served.
import { checkProjectData } from "@soksak/plugin-api";

/** The declared project data of each plugin, from its plugin.json data field. */
const declaredData = new Map();
let options = null;
// The project-data context that plugin-host calls currently use.
let activeContext = { project: null, access: new Map() };
let turn = Promise.resolve();

/**
 * Sets the host functions that the project data uses.
 *   data.get(project, plugin)          the stored plugin data object
 *   data.set(project, plugin, key, v)  a promise that stores one value
 */
export function configureData(values) {
  options = values;
}

/** Declares the project data of a plugin, which its plugin host reads and writes (docs/spec/plugins.md#project-data). */
export function declareProjectData(plugin, data) {
  declaredData.set(plugin, data);
}

// default: format is an optional field of a plugin.json data key and is 1 when absent (docs/spec/plugins.md#project-data).
const formatOf = (entry) => entry.format ?? 1;

/** Whether the stored entry has the current form: an object that has only a positive integer format and value. */
const isEntry = (stored) => stored !== null && typeof stored === "object" && !Array.isArray(stored)
  && Object.keys(stored).sort().join() === "format,value" && Number.isInteger(stored.format) && stored.format > 0;

/**
 * Checks the stored keys of a plugin for the visible project. A stored entry of another format, and a value stored without an
 * entry, fail the read with the named error and stay unchanged; the workbench converts no stored value
 * (docs/spec/plugins.md#project-data).
 */
function checkStored(project, plugin, declared) {
  const failures = new Map();
  const stored = options.data.get(project.id, plugin);
  const where = (key) => `project ${project.id} plugin ${plugin} data ${key}`;
  for (const [key, entry] of Object.entries(declared)) {
    if (!Object.hasOwn(stored, key)) continue;
    const want = formatOf(entry);
    if (isEntry(stored[key]) && stored[key].format === want) continue;
    const found = isEntry(stored[key]) ? `stored format ${stored[key].format}` : "stored without a format";
    failures.set(key, `${where(key)}: ${found} is not declared format ${want}`);
  }
  return failures;
}

/**
 * The project data functions of one plugin for one project: get(key) and set(key, value), which the plugin host calls with the same
 * checks. failures holds the stored-format failures of the keys (checkStored).
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

async function prepare(project) {
  const context = { project: project ?? null, access: new Map() }; // default: a library window has no visible project.
  if (!project) return context;
  for (const [plugin, declared] of declaredData) {
    const failures = checkStored(project, plugin, declared);
    context.access.set(plugin, dataOf(project, plugin, declared, failures));
  }
  return context;
}

/**
 * The project data of a plugin host for the visible project (docs/spec/plugin-host.md#project-data-calls). It waits for the
 * show in progress, then refuses with the named error when no project is shown.
 */
export const pluginHostData = {
  async get(plugin, key) {
    const context = activeContext;
    return accessOf(plugin, context).get(key);
  },
  async set(plugin, key, value) {
    const context = activeContext;
    return accessOf(plugin, context).set(key, value);
  },
};

function accessOf(plugin, context) {
  if (context.project === null) throw new Error(`plugin host ${plugin}: no project is shown`);
  const access = context.access.get(plugin);
  if (access !== undefined) return access;
  // A plugin that declares no project data has no key to read, so every key is refused as not declared.
  if (!declaredData.has(plugin)) return dataOf(context.project, plugin, {}, new Map());
  throw new Error(`plugin ${plugin} data of project ${context.project.id} is not loaded`);
}

/** Prepares a project's declared data without changing the project that plugin-host calls currently use. */
export function prepareData(project) {
  const done = turn.then(() => prepare(project));
  turn = done.catch((error) => dispatchEvent(new ErrorEvent("error", { message: `plugin data: ${error.message}` })));
  return done;
}

/** Installs a successfully prepared project-data context as the owner of subsequent plugin-host calls. */
export function commitData(context) {
  if (!context || !(context.access instanceof Map)) throw new Error("invalid prepared project data context");
  const previous = activeContext;
  activeContext = context;
  return previous;
}

/** Restores the prior context when publishing an installed context fails before the host changes its shown project. */
export function restoreData(installed, previous) {
  if (!installed || !previous || activeContext !== installed) throw new Error("project data context cannot be restored after another project commit");
  activeContext = previous;
}

/** Reports the project {id, root} that the window shows, or null. Preparation and installation are serialized. */
export async function showData(project) {
  commitData(await prepareData(project));
}

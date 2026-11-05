// Holds the project data that each plugin declares (docs/spec/plugins.md#project-data). A view reads and writes the keys of the
// project that its start values name, through viewDataOf.
import { checkProjectData } from "@soksak/plugin-api";

/** The declared project data of each plugin, from its plugin.json data field. */
const declaredData = new Map();
let options = null;
// The listeners of the changes of project data, each called with (project id, plugin, key).
const changeListeners = new Set();

/** Registers fn(project, plugin, key) for each change of a key of project data; returns the function that removes it. */
export function onDataChange(fn) {
  changeListeners.add(fn);
  return () => { changeListeners.delete(fn); };
}

const changed = (project, plugin, key) => { for (const fn of [...changeListeners]) fn(project, plugin, key); };

/**
 * Reports each key of plugin data that differs between the projects that the window read before and the projects that it read now,
 * as a write of another window reaches this window through the store (docs/spec/plugins.md#project-data).
 */
export function compareProjectData(before, after) {
  // default: a project or a plugin without stored data has the empty data in each comparison below.
  const earlier = new Map(before.map((project) => [project.id, project.plugins ?? {}]));
  for (const project of after) {
    // default: a project that the window had not read, and a project or plugin that stored no data, have no stored keys.
    const old = earlier.get(project.id) ?? {};
    const now = project.plugins ?? {}; // default: a project that stored no data has no stored keys.
    for (const plugin of new Set([...Object.keys(old), ...Object.keys(now)])) {
      const was = old[plugin] ?? {}; // default: a plugin that stored no data before has no stored keys.
      const is = now[plugin] ?? {}; // default: a plugin that stores no data now has no stored keys.
      for (const key of new Set([...Object.keys(was), ...Object.keys(is)])) {
        if (JSON.stringify(was[key]) !== JSON.stringify(is[key])) changed(project.id, plugin, key);
      }
    }
  }
}

/**
 * Sets the host functions that the project data uses.
 *   data.get(project, plugin)          the stored plugin data object
 *   data.set(project, plugin, key, v)  a promise that stores one value
 */
export function configureData(values) {
  options = values;
}

/** Declares the project data of a plugin, which its views read and write (docs/spec/plugins.md#project-data). */
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

/** Whether two values of project data are the same value, whatever the order of the members of their objects. */
function sameValue(one, other) {
  if (one === other) return true;
  if (one === null || other === null || typeof one !== "object" || typeof other !== "object") return false;
  if (Array.isArray(one) !== Array.isArray(other)) return false;
  const members = Object.keys(one);
  return members.length === Object.keys(other).length
    && members.every((member) => Object.hasOwn(other, member) && sameValue(one[member], other[member]));
}

/**
 * The project data functions of one plugin for one project: get(key), set(key, value) and replace(key, base, value), which the views
 * of the plugin call with the same checks. failures holds the stored-format failures of the keys (checkStored).
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
    changed(project.id, plugin, key);
  };
  // Between the comparison and the record of the write this function does not yield, so no other write comes between them.
  const replace = async (key, base, value) => {
    if (!sameValue(read(key), base)) return false;
    await write(key, value);
    return true;
  };
  return { get: read, set: write, replace };
}

/**
 * The project data of a plugin for the project that a view names in its start values (docs/spec/plugins.md#project-data). The
 * project may be one that the window does not show, so the view reads and writes its own project. declares(key) tells whether the
 * plugin declares the key, and get(key), set(key, value) and replace(key, base, value) run the checks of the stored data.
 */
export function viewDataOf(project, plugin) {
  // default: a plugin that declares no data keys has the empty declaration.
  const declared = declaredData.get(plugin) ?? {};
  const access = dataOf(project, plugin, declared, checkStored(project, plugin, declared));
  return { declares: (key) => Object.hasOwn(declared, key), get: access.get, set: access.set, replace: access.replace };
}

// Holds the data that each plugin declares (docs/spec/plugins.md#project-data, docs/spec/plugins.md#plugin-data). A view reads and writes
// the project keys of the project that its start values name, and the plugin keys of its plugin, through viewDataOf.
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
 * Reports each plugin key that differs between the plugin keys that the window read before and the plugin keys that it read now, as a
 * write of another window reaches this window through the store (docs/spec/plugins.md#plugin-data). A plugin key belongs to no
 * project, so the change names the project null.
 */
export function comparePluginData(before, after) {
  for (const plugin of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[plugin] ?? {}; // default: a plugin that stored no plugin key before has no stored keys.
    const is = after[plugin] ?? {}; // default: a plugin that stores no plugin key now has no stored keys.
    for (const key of new Set([...Object.keys(was), ...Object.keys(is)])) {
      if (JSON.stringify(was[key]) !== JSON.stringify(is[key])) changed(null, plugin, key);
    }
  }
}

/**
 * Sets the host functions that the data uses.
 *   data.get(project, plugin)          the stored project data object of the plugin
 *   data.set(project, plugin, key, v)  a promise that stores one value
 *   data.plugin.get(plugin)            the stored plugin keys of the plugin; throws the error of a refused plugin-data.json
 *   data.plugin.put(plugin, key, entry, base, default)
 *                                      a promise of whether the store stored the entry; with base and default the store stores it
 *                                      only when the standing value equals base (docs/spec/plugins.md#plugin-data)
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
// default: scope is an optional field of a plugin.json data key and is project when absent (docs/spec/plugins.md#plugin-data).
const scopeOf = (entry) => entry.scope ?? "project";

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
  if (project === null) return failures;
  const stored = options.data.get(project.id, plugin);
  const where = (key) => `project ${project.id} plugin ${plugin} data ${key}`;
  for (const [key, entry] of Object.entries(declared)) {
    if (scopeOf(entry) !== "project" || !Object.hasOwn(stored, key)) continue;
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
    if (!Object.hasOwn(declared, key)) throw new Error(`${plugin} data ${key} is not declared`);
    if (scopeOf(declared[key]) === "plugin") return readPluginKey(plugin, declared, key);
    if (project === null) throw new Error(`${plugin} data ${key} requires a project`);
    const stored = options.data.get(project.id, plugin);
    if (failures.has(key)) throw new Error(failures.get(key));
    if (!Object.hasOwn(stored, key)) return structuredClone(declared[key].default);
    return checkProjectData(plugin, declared, key, stored[key].value);
  };
  const write = async (key, value) => {
    checkProjectData(plugin, declared, key, value);
    if (scopeOf(declared[key]) === "plugin") {
      options.data.plugin.get(plugin);
      await options.data.plugin.put(plugin, key, { format: formatOf(declared[key]), value });
      changed(null, plugin, key);
      return;
    }
    if (project === null) throw new Error(`${plugin} data ${key} requires a project`);
    await options.data.set(project.id, plugin, key, { format: formatOf(declared[key]), value });
    failures.delete(key);
    changed(project.id, plugin, key);
  };
  // Between the comparison and the record of the write this function does not yield, so no other write comes between them.
  const replace = async (key, base, value) => {
    if (Object.hasOwn(declared, key) && scopeOf(declared[key]) === "plugin") {
      checkProjectData(plugin, declared, key, value);
      options.data.plugin.get(plugin);
      // The store compares base with the value that every window stored, so two windows never both replace the same value.
      const stored = await options.data.plugin.put(plugin, key, { format: formatOf(declared[key]), value }, base, declared[key].default);
      if (stored) changed(null, plugin, key);
      return stored;
    }
    if (!sameValue(read(key), base)) return false;
    await write(key, value);
    return true;
  };
  return { get: read, set: write, replace };
}

/**
 * The value of a plugin key of the plugin (docs/spec/plugins.md#plugin-data): the declared default when the key stores no entry. A
 * refused plugin-data.json throws its error, and an entry of another format fails with a name of the plugin and the key.
 */
function readPluginKey(plugin, declared, key) {
  const stored = options.data.plugin.get(plugin);
  if (!Object.hasOwn(stored, key)) return structuredClone(declared[key].default);
  const want = formatOf(declared[key]);
  if (!isEntry(stored[key]) || stored[key].format !== want) {
    const found = isEntry(stored[key]) ? `stored format ${stored[key].format}` : "stored without a format";
    throw new Error(`plugin ${plugin} data ${key}: ${found} is not declared format ${want}`);
  }
  return checkProjectData(plugin, declared, key, stored[key].value);
}

/**
 * The data of a plugin for the project that a view names in its start values, null for a view without a project
 * (docs/spec/plugins.md#project-data, docs/spec/plugins.md#plugin-data). The project may be one that the window does not show, so the
 * view reads and writes its own project. declares(key) tells whether the plugin declares the key, scope(key) whether it is a project or a
 * plugin key, and get(key), set(key, value) and replace(key, base, value) run the checks of the stored data.
 */
export function viewDataOf(project, plugin) {
  // default: a plugin that declares no data keys has the empty declaration.
  const declared = declaredData.get(plugin) ?? {};
  const access = dataOf(project, plugin, declared, checkStored(project, plugin, declared));
  return { declares: (key) => Object.hasOwn(declared, key), scope: (key) => scopeOf(declared[key]), get: access.get, set: access.set, replace: access.replace };
}

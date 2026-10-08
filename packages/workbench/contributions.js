// The contributions to extension points (docs/spec/plugins.md#extension-points). The workbench resolves them from the
// declarations of the installed and enabled plugins when the page loads, gives a provider page its connected items, and
// makes only the item whose module fails invalid.
import { resolveContributions } from "@soksak/plugin-api";

let resolved = [];
let declared = new Map();
const listeners = new Set();

/** Resolves the contributions of the installed and enabled plugins ({id, package, version, manifest}) once per page load. */
export function installContributions(installed) {
  resolved = resolveContributions(installed);
  // default: extends is an optional field of plugin.json; a plugin without it declares no extension point.
  declared = new Map(installed.map((plugin) => [plugin.id, new Set(Object.keys(plugin.manifest.extends ?? {}))]));
}

/** The value of the status core.contributions: {plugin, point, index, state, reason} for each contributed item. */
export function contributionsState() {
  return resolved.map(({ plugin, point, index, state, reason }) => ({ plugin, point, index, state, reason }));
}

/** Calls fn when the state of a contribution changes and returns a function that removes it. */
export function onContributionsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The items connected to the extension point point of the plugin provider, each {plugin, item, module, fail(reason)}.
 * fail makes that item invalid and leaves the other items connected. A point that the provider does not declare is an error.
 */
export function contributionsOf(provider, point) {
  if (!declared.get(provider)?.has(point)) throw new Error(`extension point ${point} is not declared by ${provider}`);
  const name = `${provider}.${point}`;
  return resolved.filter((entry) => entry.point === name && entry.state === "connected").map((entry) => Object.freeze({
    plugin: entry.plugin,
    item: structuredClone(entry.item),
    module: entry.module,
    fail(reason) {
      entry.state = "invalid";
      entry.reason = `extend failed: ${reason instanceof Error ? reason.message : String(reason)}`;
      for (const listener of listeners) listener();
    },
  }));
}

// Performs the UI operations of the document as core commands.
//
// Elements are connected to commands in the same way as in a plugin page (createBinder of
// @soksak/plugin-api). Only commands declared in the registry can be connected.
import { createBinder } from "@soksak/plugin-api";
import { registry } from "./exposure.js";

export { commandOf, valueOf } from "@soksak/plugin-api";

/* The function to call when a binding changes. The watch of core.page.audit registers it. */
const listeners = new Set();

/**
 * Runs the command that the element points to. A plugin command runs on the surface of the nearest data-surface that contains the element, if that surface
 * registered it, and otherwise on the default selected surface of the request. The operations of sidebar sections use this path.
 */
const runFrom = (name, params = {}, el) => {
  if (!registry.declared("command", name) || name.startsWith("core.")) return registry.run(name, params);
  const windowSection = el?.closest("[data-window-sidebar]");
  // default: a window sidebar section with general content has no linked surface, so the owner is null.
  if (windowSection) return registry.runOwned(name, params, windowSection.dataset.surface ?? null);
  // default: a command run without an element or from an element outside a surface has no wanted surface (null).
  const wanted = el?.closest("[data-surface]")?.dataset.surface ?? null;
  // default: when there is no surface to choose, the command runs without a surface, and the registry chooses by registration order.
  return registry.run(name, params, registry.chosen("command", name, wanted) ?? undefined);
};

const binder = createBinder(runFrom, {
  check(name) {
    if (!registry.declared("command", name)) throw new Error(`command ${name} is not declared`);
  },
  changed: () => { for (const fn of listeners) fn(); },
});

/** Runs one command. A failure returns to the caller as a rejection. */
export const run = (name, params = {}) => registry.run(name, params);
/** Runs one command of the plugin of surface on that surface. */
export const runOn = (name, params, surface) => registry.run(name, params, surface);
export const { audit, bind, delegate, mark } = binder;

/** Calls fn when a binding changes. */
export function onBinding(fn) {
  listeners.add(fn);
}

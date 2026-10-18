// The one plugin operation state of this window (plugin-operations.js). The core.plugins status and the plugin section of the settings window use it together.
import { host } from "@soksak/runtime";
import { pluginUnits } from "./environment.js";
import { createAppUpdate } from "./app-update.js";
import { createPluginOperations } from "./plugin-operations.js";

const listeners = new Set();
const notify = () => { for (const fn of listeners) fn(); };

export const pluginOperations = createPluginOperations({ host, loaded: pluginUnits, changed: notify });

/** The application update of this window (app-update.js), which redraws the same listeners. */
export const appUpdate = createAppUpdate({ host, plugins: () => pluginOperations.state(), changed: notify });

/** Calls fn whenever the plugin operation state changes. */
export function onPluginOperations(fn) {
  listeners.add(fn);
}

/**
 * Subscribes to plugins-changed from the host, then reads the state once and applies a difference between the loaded
 * and the installed plugins, so a change made before the subscription is applied as well; each later event reads the
 * state again and applies the change to this window with apply (docs/spec/installation.md#applying-a-change). An apply
 * that runs serves a change seen again through the event or the read, so one change starts one apply. A read failure
 * is reported as the error of the state, and a failure of apply reaches the error display through the document's
 * unhandledrejection.
 */
export async function followPluginChanges(apply) {
  if (!host) return;
  let running = null;
  const once = () => (running ??= Promise.resolve(apply()).finally(() => { running = null; }));
  host.on("plugins-changed", async () => {
    await pluginOperations.refresh();
    await pluginOperations.refreshOutdated();
    await once();
  });
  await pluginOperations.refresh();
  await pluginOperations.refreshOutdated();
  if (pluginOperations.status().reload) await once();
}

/**
 * On window-active from the host, reads the plugin state again, which the host sends each time the window becomes active: the registry sends no change event, so a newer
 * version appears only when the index is read (docs/spec/installation.md). The read reports its failure as the error of
 * the state.
 */
export function followActivation() {
  if (host) host.on("window-active", () => { pluginOperations.refresh(); appUpdate.refresh(); });
}

/** On sidecars-changed from the host, reads the outdated sidecars again (docs/spec/installation.md). */
export function followSidecarChanges() {
  if (host) host.on("sidecars-changed", () => pluginOperations.refreshOutdated());
}

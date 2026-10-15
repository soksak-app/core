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
 * On plugins-changed from the host, reads the state again and applies the change to this window with apply
 * (docs/spec/installation.md#applying-a-change). A read failure is reported as the error of the state, and a failure
 * of apply reaches the error display through the document's unhandledrejection.
 */
export function followPluginChanges(apply) {
  if (host) host.on("plugins-changed", async () => {
    await pluginOperations.refresh();
    await pluginOperations.refreshOutdated();
    await apply();
  });
}

/**
 * On window-active from the host, reads the plugin state again, which the host sends each time the window becomes active: the registry sends no change event, so a newer
 * version appears only when the index is read (docs/spec/installation.md). The read reports its failure as the error of
 * the state.
 */
export function followActivation() {
  if (host) host.on("window-active", () => { pluginOperations.refresh(); appUpdate.refresh(); });
}

/** On plugins-progress from the host, records the step on the running operation (docs/spec/installation.md#applications). */
export function followPluginProgress() {
  if (host) host.on("plugins-progress", (progress) => pluginOperations.progress(progress));
}

/** On sidecars-changed from the host, reads the outdated sidecars again (docs/spec/installation.md). */
export function followSidecarChanges() {
  if (host) host.on("sidecars-changed", () => pluginOperations.refreshOutdated());
}

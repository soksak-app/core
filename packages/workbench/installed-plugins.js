// The one plugin operation state of this window (plugin-operations.js). The core.plugins status and the plugin section of the settings tab use it together.
import { host } from "@soksak/runtime";
import { pluginUnits, refusedPlugins, unmetPlugins } from "./environment.js";
import { createAppUpdate } from "./app-update.js";
import { setPluginRows } from "./missing-plugins.js";
import { createPluginOperations } from "./plugin-operations.js";
import { emitEvent } from "./page-log.js";
import { showError } from "./shown-errors.js";

const listeners = new Set();
const notify = () => { for (const fn of listeners) fn(); };

export const pluginOperations = createPluginOperations({ host, loaded: pluginUnits, refused: refusedPlugins, unmet: unmetPlugins, changed: notify });
// The states of the missing plugins of the sets and the sidebars come from these rows (docs/spec/plugins.md#missing-plugins).
setPluginRows(() => pluginOperations.status().plugins);

/** The application update of this window (app-update.js), which redraws the same listeners. */
export const appUpdate = createAppUpdate({ host, plugins: () => pluginOperations.state(), changed: notify });

/** Calls fn whenever the plugin operation state changes. */
export function onPluginOperations(fn) {
  listeners.add(fn);
}

/** Shows each failure of the update at start that the state read reported through the error display (docs/spec/installation.md#update-at-start). */
function showStartFailures() {
  for (const failure of pluginOperations.startFailures()) showError(document, failure.where, failure.text);
}

/**
 * Subscribes to plugins-changed from the host, then reads the state once and applies a difference between the loaded
 * and the installed plugins, so a change made before the subscription is applied as well; each later event reads the
 * state again and applies the change to this window with apply (docs/spec/installation.md#applying-a-change). At most
 * one apply runs: an event during a running apply marks one more apply due, which runs after it settles when the state
 * read by that event still differs, so a newer change is not served by an apply that read an earlier state. A read
 * failure is reported as the error of the state, and a failure of apply reaches the error display through the
 * document's unhandledrejection.
 */
export async function followPluginChanges(apply) {
  if (!host) return;
  let running = null;
  let due = false;
  const once = () => {
    if (running) {
      due = true;
      return running;
    }
    running = (async () => {
      try {
        return await apply("plugins-changed");
      } finally {
        running = null;
        if (due) {
          due = false;
          if (pluginOperations.status().reload) once();
        }
      }
    })();
    return running;
  };
  host.on("plugins-changed", async () => {
    await pluginOperations.refresh();
    showStartFailures();
    await pluginOperations.refreshOutdated();
    await once();
  });
  await pluginOperations.refresh();
  showStartFailures();
  await pluginOperations.refreshOutdated();
  if (pluginOperations.status().reload) await once();
}

/**
 * On window-active from the host, reads the plugin state again, which the host sends each time the window becomes active: the registry sends no change event, so a newer
 * version appears only when the index is read (docs/spec/installation.md). The read reports its failure as the error of
 * the state.
 */
export function followActivation() {
  if (host) {
    host.on("window-active", () => {
      emitEvent("info", "workbench.window.active", {});
      pluginOperations.refresh().then(() => emitEvent("info", "workbench.plugins.reread", { updates: pluginOperations.status().updates.length }));
      appUpdate.refresh();
    });
  }
}

/** On sidecars-changed from the host, reads the outdated sidecars again (docs/spec/installation.md). */
export function followSidecarChanges() {
  if (host) host.on("sidecars-changed", () => pluginOperations.refreshOutdated());
}

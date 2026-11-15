// The page module of a view that subscribes to the changes of the window as a plugin page does: the settings, the text scale, the
// project data and a status. Each change that a subscription receives is kept in arrival order.
import { createViewBridge } from "@soksak/plugin-api/view";

export const seen = [];
export const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: () => {},
});

/** Resolves when every subscription of the page is registered with the host. */
export const ready = Promise.all([
  bridge.runtime.settings.on((values) => seen.push(["settings", values])),
  bridge.runtime.textSize.on((factor) => seen.push(["textSize", factor])),
  bridge.runtime.data.on((change) => seen.push(["data", change.key])),
  bridge.runtime.status.watch("probe.state", (value) => seen.push(["status", value])),
]);

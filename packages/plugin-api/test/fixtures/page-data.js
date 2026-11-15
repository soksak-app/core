// The page module of a view that subscribes to the project data and changes a key with runtime.data.change, as a plugin page does.
import { createViewBridge } from "@soksak/plugin-api/view";

export const seen = [];
export const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: () => {},
});

/** Resolves when the data subscription of the page is registered with the host. */
export const ready = bridge.runtime.data.on((change) => seen.push(change.key));

/** Appends the text "-page" to the value of the key note, with the read and replace of runtime.data.change. */
export const bump = () => bridge.runtime.data.change("note", (value) => `${value}-page`);

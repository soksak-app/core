// The page module of a view that subscribes to the document events of its region, as a plugin page does before the region is mounted.
import { createViewBridge } from "@soksak/plugin-api/view";

export const received = [];
export const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: () => {},
});

/** Resolves when the document subscriptions of the page are registered with the host. */
export const ready = Promise.all([
  bridge.runtime.native.on("document-state", (data) => received.push(["document-state", data])),
  bridge.runtime.native.on("document-message", (data) => received.push(["document-message", data])),
]);

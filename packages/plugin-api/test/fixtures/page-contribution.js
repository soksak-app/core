// The page module of a view that imports the modules that the host answers for a point, as a plugin page does.
import { createViewBridge } from "@soksak/plugin-api/view";

export const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: () => {},
});

/** Imports the module of each contribution of the point, and resolves with the name and the label that each module exports. */
export async function loadContributions(point) {
  const items = await bridge.contributions(point);
  return Promise.all(items.map(async (entry) => ({ name: entry.item.name, label: (await import(entry.module)).label })));
}

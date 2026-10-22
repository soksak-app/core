// The view of the provider probe: it imports the module of each connected item of its point items, calls its export describe with
// the item, and reports the answers as the status probeprovider.items (docs/spec/plugins.md#extension-points).
import { createViewBridge } from "@soksak/plugin-api/view";

const bridge = createViewBridge({ handler: window.webkit.messageHandlers["sok-view"], report: () => {} });
const answers = [];
for (const { plugin, item, module, fail } of await bridge.contributions("items")) {
  try {
    const { describe } = await import(module);
    answers.push({ plugin, label: item.label, answer: describe(item) });
  } catch (error) {
    fail(String(error?.message ?? error));
  }
}
document.getElementById("root").textContent = answers.map((entry) => entry.answer).join("\n");
await bridge.exposure.register("status", "probeprovider.items");
bridge.snapshots.push("probeprovider.items", answers);

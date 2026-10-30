// The view of the provider probe: it imports the module of each connected item of its point items, calls its export describe with
// the item, and reports the answers as the status probeprovider.items (docs/spec/plugins.md#extension-points).
import { createExpose } from "@soksak/plugin-api";
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
// The view answers the exposure requests that the main page forwards for its surface (docs/spec/exposure.md#relay), so a status
// watch of the surface reads the answers.
const expose = createExpose({
  register: bridge.exposure.register,
  reply: bridge.exposure.reply,
  report: (text) => bridge.runtime.error("probeprovider exposure", text),
  onRequest: (answer) => bridge.runtime.native.on("exposure-request", answer),
}, () => window.sokSurface.declarations);
// The answers are read once at the start, so the status has no change to announce.
await expose.status("probeprovider.items", () => answers, () => () => {});

// This consumer fixture controls tab reports, not filesystem writes or Editor behavior.
import { createExpose } from "@soksak/plugin-api";
import { createViewBridge, createViewReporter } from "@soksak/plugin-api/view";

const bridge = createViewBridge({ handler: window.webkit.messageHandlers["sok-view"],
  report: createViewReporter({ reportError: window.reportError.bind(window), console: window.console }) });
const expose = createExpose({
  register: bridge.exposure.register, reply: bridge.exposure.reply, changed: bridge.exposure.changed,
  report: (text) => bridge.runtime.error("probeclose exposure", text),
  onRequest: (answer) => bridge.runtime.native.on("exposure-request", answer),
}, () => window.sokSurface.declarations);
let state = { saves: 0, modified: false }, keepModified = true;
const listeners = new Set();
const report = async (modified) => {
  await bridge.calls.request("tab.modified", modified);
  state = { ...state, modified };
  for (const listener of listeners) listener(state);
};
await bridge.commands.register("probeclose.prepare", async (params) => {
  keepModified = params.keepModified;
  await report(true);
  return null;
});
await bridge.commands.register("probeclose.save", async () => {
  state = { ...state, saves: state.saves + 1 };
  await report(keepModified);
  return null;
});
await expose.status("probeclose.state", () => state, (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
});

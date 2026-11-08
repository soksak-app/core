// The start probe of the window checks: a tab that holds a card of the start layout and reports that it started, so the plugin under
// check opens only in the tabs that a check opens.
import { createExpose } from "@soksak/plugin-api";
import { createViewBridge, createViewReporter } from "@soksak/plugin-api/view";

const bridge = createViewBridge({ handler: window.webkit.messageHandlers["sok-view"],
  report: createViewReporter({ reportError: window.reportError.bind(window), console: window.console }) });
const expose = createExpose({
  register: bridge.exposure.register, reply: bridge.exposure.reply, changed: bridge.exposure.changed,
  report: (text) => bridge.runtime.error("startprobe exposure", text),
  onRequest: (answer) => bridge.runtime.native.on("exposure-request", answer),
}, () => window.sokSurface.declarations);
const state = { started: true };
await expose.status("startprobe.view", () => state, () => () => {});

// The entry of the second layout probe: a tab view without sidebar defaults that serves its surface, size and text size as
// layoutprobe2.surface, so a check places it beside the first probe and sees a window sidebar without an override.
import { createExpose } from "@soksak/plugin-api";
import { createViewBridge, createViewReporter } from "@soksak/plugin-api/view";
import { startSecondProbe } from "./second-probe.js";

const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: createViewReporter({ reportError: window.reportError.bind(window), console: window.console }),
});
const expose = createExpose({
  register: bridge.exposure.register, reply: bridge.exposure.reply, changed: bridge.exposure.changed,
  report: (text) => bridge.runtime.error("layoutprobe2 exposure", text),
  onRequest: (answer) => bridge.runtime.native.on("exposure-request", answer),
}, () => window.sokSurface.declarations);
await startSecondProbe({ bridge, expose, view: window });

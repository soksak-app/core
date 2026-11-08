// The entry of the save close probe view: it connects the view bridge and the exposure of the page and starts the probe.
import { createExpose } from "@soksak/plugin-api";
import { createViewBridge, createViewReporter } from "@soksak/plugin-api/view";
import { startCloseProbe } from "./close-probe.js";

const bridge = createViewBridge({ handler: window.webkit.messageHandlers["sok-view"],
  report: createViewReporter({ reportError: window.reportError.bind(window), console: window.console }) });
const expose = createExpose({
  register: bridge.exposure.register, reply: bridge.exposure.reply, changed: bridge.exposure.changed,
  report: (text) => bridge.runtime.error("probeclose exposure", text),
  onRequest: (answer) => bridge.runtime.native.on("exposure-request", answer),
}, () => window.sokSurface.declarations);
await startCloseProbe({ bridge, expose, storage: window.localStorage, surface: window.sokSurface.surface });

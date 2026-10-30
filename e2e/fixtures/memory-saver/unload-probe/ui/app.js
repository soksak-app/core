// The entry of the unload probe view: it connects the view bridge and the exposure of the page and starts the probe.
import { createExpose } from "@soksak/plugin-api";
import { createViewBridge, createViewReporter } from "@soksak/plugin-api/view";
import { startUnloadProbe } from "./unload-probe.js";

const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: createViewReporter({ reportError: window.reportError.bind(window), console: window.console }),
});
const expose = createExpose({
  register: bridge.exposure.register,
  reply: bridge.exposure.reply,
  report: (text) => bridge.runtime.error("probeunload exposure", text),
  onRequest: (answer) => bridge.runtime.native.on("exposure-request", answer),
}, () => window.sokSurface.declarations);
await startUnloadProbe({ bridge, expose, document });

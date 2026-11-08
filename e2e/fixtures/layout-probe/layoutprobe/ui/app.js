// The entry of the tab view of the layout probe: it connects the view bridge and the exposure of the page and starts the probe.
import { createExpose } from "@soksak/plugin-api";
import { createViewBridge, createViewReporter } from "@soksak/plugin-api/view";
import { probeExposurePort } from "./port.js";
import { startLayoutProbe } from "./layout-probe.js";

const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: createViewReporter({ reportError: window.reportError.bind(window), console: window.console }),
});
const expose = createExpose(probeExposurePort(bridge), () => window.sokSurface.declarations);
await startLayoutProbe({ bridge, expose, view: window });

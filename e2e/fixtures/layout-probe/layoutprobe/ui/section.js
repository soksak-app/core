// The entry of a section view of the layout probe: it connects the view bridge and the exposure of the page and starts the section.
import { createExpose } from "@soksak/plugin-api";
import { createViewBridge, createViewReporter } from "@soksak/plugin-api/view";
import { probeExposurePort } from "./port.js";
import { startProbeSection } from "./layout-probe.js";

const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: createViewReporter({ reportError: window.reportError.bind(window), console: window.console }),
});
const expose = createExpose(probeExposurePort(bridge), () => window.sokSurface.declarations);
document.getElementById("name").textContent = window.sokSurface.section.id;
await startProbeSection({ bridge, expose, view: window });

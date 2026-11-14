// The entry of the agent probe view: it connects the view bridge and the exposure of the page and starts the probe.
import { createExpose } from "@soksak/plugin-api";
import { createViewBridge, createViewReporter } from "@soksak/plugin-api/view";
import { probeExposurePort, startAgentProbe } from "./agent-probe.js";

const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: createViewReporter({ reportError: window.reportError.bind(window), console: window.console }),
});
const expose = createExpose(probeExposurePort(bridge), () => window.sokSurface.declarations);
await startAgentProbe({ bridge, expose, view: window });

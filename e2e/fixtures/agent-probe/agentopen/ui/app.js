// The entry of the agent open probe view: it connects the view bridge and the exposure of the page and starts the probe.
import { createExpose } from "@soksak/plugin-api";
import { createViewBridge, createViewReporter } from "@soksak/plugin-api/view";
import { probeExposurePort, startAgentOpen } from "./agent-open.js";

const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: createViewReporter({ reportError: window.reportError.bind(window), console: window.console }),
});
const expose = createExpose(probeExposurePort(bridge), () => window.sokSurface.declarations);
await startAgentOpen({ expose, view: window });

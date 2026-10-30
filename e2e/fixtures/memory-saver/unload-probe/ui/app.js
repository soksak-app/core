// The entry of the unload probe view: it connects the view bridge of the page and starts the probe.
import { createViewBridge, createViewReporter } from "@soksak/plugin-api/view";
import { startUnloadProbe } from "./unload-probe.js";

const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: createViewReporter({ reportError: window.reportError.bind(window), console: window.console }),
});
await startUnloadProbe({ bridge, document });

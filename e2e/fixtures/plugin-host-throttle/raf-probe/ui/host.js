// This test-only host page counts animation frames and reports a sample only when its declared command is called.
import { createViewBridge, createViewReporter } from "@soksak/plugin-api/view";
import { startRafProbe } from "./raf-probe.js";

const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: createViewReporter({ reportError: window.reportError.bind(window), console: window.console }),
});
await startRafProbe({ bridge, requestAnimationFrame, performance });

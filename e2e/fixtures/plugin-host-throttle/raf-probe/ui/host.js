// This test-only host page counts animation frames and reports a sample only when its declared command is called.
import { createViewBridge } from "@soksak/plugin-api/view";
import { createRafProbeBridgeOptions } from "./bridge-report.js";
import { startRafProbe } from "./raf-probe.js";

let bridge;

bridge = createViewBridge(createRafProbeBridgeOptions({
  handler: window.webkit.messageHandlers["sok-view"],
  reportError: window.reportError.bind(window),
  console: window.console,
}));
await startRafProbe({ bridge, requestAnimationFrame, performance });

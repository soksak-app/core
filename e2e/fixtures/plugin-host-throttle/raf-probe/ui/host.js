// This test-only host page counts animation frames and reports a sample only when its declared command is called.
import { createViewBridge } from "@soksak/plugin-api/view";
import { createRafProbeBridgeOptions } from "./bridge-report.js";

let bridge;

bridge = createViewBridge(createRafProbeBridgeOptions({
  handler: window.webkit.messageHandlers["sok-view"],
  reportError: window.reportError.bind(window),
  console: window.console,
}));
const status = "probehostraf.sample";
let frames = 0;
const start = performance.now();

function countFrame() {
  frames++;
  requestAnimationFrame(countFrame);
}

function readSample() {
  return { frames, performanceNow: performance.now(), timeOrigin: performance.timeOrigin };
}

requestAnimationFrame(countFrame);
await bridge.exposure.register("status", status);
await bridge.commands.register("probehostraf.read", () => {
  const sample = readSample();
  bridge.snapshots.push(status, sample);
  return sample;
});
bridge.snapshots.push(status, { frames, performanceNow: start, timeOrigin: performance.timeOrigin });

// The entry of the plain view probe: its page holds one empty document region and observes the size of its document, so a drag of this
// view measures the floor of the view path without plugin code.
import { createViewBridge, createViewReporter } from "@soksak/plugin-api/view";
import { observeViewDocumentFrames } from "@soksak/plugin-api/diagnostic-view-frames";

const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: createViewReporter({ reportError: window.reportError.bind(window), console: window.console }),
});
await bridge.composition.create({ regions: { page: document.getElementById("document") }, overlays: {} });
let stop = null;
await bridge.commands.register("probeplain.measure", ({ action }) => {
  if (action === "start") {
    if (stop !== null) throw new Error("the plain view observation is already active");
    stop = observeViewDocumentFrames({
      document,
      log: bridge.runtime.log,
      ResizeObserver: window.ResizeObserver,
      requestAnimationFrame: window.requestAnimationFrame.bind(window),
      cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
      now: performance.now.bind(performance),
      timeOriginMs: performance.timeOrigin,
    });
    return { sourceClock: { documentTimeOriginMs: performance.timeOrigin, sourceNowMs: performance.now(), sourceResolutionMs: 1 } };
  }
  if (action === "stop") {
    if (stop === null) throw new Error("the plain view observation is not active");
    stop();
    stop = null;
    return {};
  }
  throw new TypeError("probeplain.measure action must be start or stop");
});

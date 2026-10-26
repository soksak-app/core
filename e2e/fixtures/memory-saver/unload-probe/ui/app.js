// The view of the unload probe (docs/spec/plugins.md#memory-saver): one document region whose address the view writes as the tab
// state, and whose state, with the session history and the tab state read at the start, is the status probeunload.location.
import { createViewBridge } from "@soksak/plugin-api/view";
import { createBridgeReporter } from "./bridge-report.js";

const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: createBridgeReporter({ reportError: window.reportError.bind(window), console: window.console }),
});
const restored = await bridge.calls.request("tab.state.read", null);
const composition = await bridge.composition.create({ regions: { page: document.getElementById("document") }, overlays: {} });
const region = composition.region("page");
let current = { url: "", loading: false, history: { entries: [], index: -1 }, restored };
region.onState((state) => {
  current = { url: state.url, loading: state.loading, history: state.history, restored };
  if (state.url !== "") bridge.calls.request("tab.state.write", { url: state.url });
  bridge.snapshots.push("probeunload.location", current);
});
bridge.commands.register("probeunload.load", async ({ url }) => {
  await region.load(url);
  return null;
});
bridge.commands.register("probeunload.modified", ({ modified }) => bridge.calls.request("tab.modified", modified));
await bridge.exposure.register("status", "probeunload.location");
await bridge.exposure.register("command", "probeunload.load");
await bridge.exposure.register("command", "probeunload.modified");
bridge.snapshots.push("probeunload.location", current);

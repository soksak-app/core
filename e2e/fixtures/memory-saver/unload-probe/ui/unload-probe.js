// The view of the unload probe (docs/spec/plugins.md#memory-saver): one document region whose address the view writes as the tab
// state, and whose state, with the session history and the tab state read at the start, is the status probeunload.location. The
// view serves the status through its exposure, which answers the requests that the main page forwards for its surface.
export async function startUnloadProbe({ bridge, expose, document }) {
  const restored = await bridge.calls.request("tab.state.read", null);
  const composition = await bridge.composition.create({ regions: { page: document.getElementById("document") }, overlays: {} });
  const region = composition.region("page");
  let current = { url: "", loading: false, history: { entries: [], index: -1 }, restored };
  const listeners = new Set();
  region.onState((state) => {
    current = { url: state.url, loading: state.loading, history: state.history, restored };
    if (state.url !== "") bridge.calls.request("tab.state.write", { url: state.url });
    for (const listener of listeners) listener(current);
  });
  await bridge.commands.register("probeunload.load", async ({ url }) => {
    await region.load(url);
    return null;
  });
  await bridge.commands.register("probeunload.modified", ({ modified }) => bridge.calls.request("tab.modified", modified));
  await expose.status("probeunload.location", () => current, (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
}

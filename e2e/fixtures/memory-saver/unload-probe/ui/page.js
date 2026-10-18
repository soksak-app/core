// The surface of the unload probe (docs/spec/plugins.md#memory-saver): one document region whose address the surface writes as
// the tab state, and whose state, with the session history and the tab state read at the mount, is the status probeunload.location.
export async function mount(root, context) {
  root.innerHTML = `<div id="document" style="height:100%"></div>`;
  const restored = context.tab.state.read();
  const composition = await context.composition.create({ regions: { page: root.querySelector("#document") }, overlays: {} });
  const region = composition.region("page");
  let current = { url: "", loading: false, history: { entries: [], index: -1 }, restored };
  const listeners = new Set();
  const stopState = region.onState((state) => {
    current = { url: state.url, loading: state.loading, history: state.history, restored };
    if (state.url !== "") context.tab.state.write({ url: state.url });
    for (const fn of listeners) fn(current);
  });
  context.exposure.status("probeunload.location", () => current, (fn) => {
    listeners.add(fn);
    fn(current);
    return () => listeners.delete(fn);
  });
  context.exposure.command("probeunload.load", async ({ url }) => {
    await region.load(url);
    return null;
  });
  context.exposure.command("probeunload.modified", ({ modified }) => {
    context.tab.modified(modified);
    return null;
  });
  context.status.report("ready");
  return {
    async dispose() {
      stopState();
      listeners.clear();
      await composition.dispose();
      await context.exposure.dispose();
      root.replaceChildren();
    },
  };
}

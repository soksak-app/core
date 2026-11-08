// The save close probe: it reports the modified state of its tab independently of a successful save reply. This consumer fixture
// controls tab reports and writes no file. The save count of a tab lives in the local storage of the view under
// a key of its surface id, so a reload of the same tab reads the count it had before the reload.

/** The local storage key of the save count of the tab with surface id surface. */
export function savesKey(surface) {
  return `probeclose.saves:${surface}`;
}

/**
 * Starts the probe of the surface `surface`: registers probeclose.prepare and probeclose.save on `bridge` and serves the status
 * probeclose.state through `expose`. `storage` holds the save count (localStorage of the view); a tab without a stored count has
 * saved 0 times.
 */
export async function startCloseProbe({ bridge, expose, storage, surface }) {
  const key = savesKey(surface);
  // default: a tab that never saved has no stored count.
  const stored = Number.parseInt(storage.getItem(key) ?? "0", 10);
  let state = { saves: Number.isSafeInteger(stored) && stored >= 0 ? stored : 0, modified: false };
  let keepModified = true;
  const listeners = new Set();
  const report = async (modified) => {
    await bridge.calls.request("tab.modified", modified);
    state = { ...state, modified };
    for (const listener of listeners) listener(state);
  };
  await bridge.commands.register("probeclose.prepare", async (params) => {
    keepModified = params.keepModified;
    await report(true);
    return null;
  });
  await bridge.commands.register("probeclose.save", async () => {
    state = { ...state, saves: state.saves + 1 };
    storage.setItem(key, String(state.saves));
    await report(keepModified);
    return null;
  });
  await expose.status("probeclose.state", () => state, (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
}

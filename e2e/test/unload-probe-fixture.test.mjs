import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startUnloadProbe } from "../fixtures/memory-saver/unload-probe/ui/unload-probe.js";

const manifestPath = fileURLToPath(new URL("../fixtures/memory-saver/unload-probe/plugin.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// The main page forwards a status request of the probe surface to the view (docs/spec/native-surfaces.md#view-surfaces, view
// exposure), so the view serves the declared status probeunload.location through its exposure and pushes no declared UI snapshot,
// because the probe declares no section.
test("the unload probe serves its declared status through its exposure and follows the region state", { timeout: 1000 }, async () => {
  const declared = manifest.exposes.status.map((status) => status.name);
  const served = new Map();
  let onState;
  const bridge = {
    calls: { request: async (name) => (name === "tab.state.read" ? { url: "https://example.test/" } : null) },
    composition: { create: async () => ({ region: () => ({ onState: (listener) => { onState = listener; }, load: async () => {} }) }) },
    commands: { register: async () => {} },
    snapshots: { push: () => { throw new Error("the probe pushed a declared UI snapshot"); } },
  };
  const expose = { status: async (name, read, subscribe) => { served.set(name, { read, subscribe }); } };

  await startUnloadProbe({ bridge, expose, document: { getElementById: () => ({}) } });

  assert.deepEqual([...served.keys()], declared);
  const location = served.get("probeunload.location");
  assert.deepEqual(location.read(), { url: "", loading: false, history: { entries: [], index: -1 }, restored: { url: "https://example.test/" } });
  const values = [];
  const stop = location.subscribe((value) => values.push(value));
  const history = { entries: [{ url: "https://example.test/next", title: "" }], index: 0 };
  onState({ url: "https://example.test/next", loading: false, history });
  stop();
  onState({ url: "https://example.test/later", loading: true, history });
  assert.deepEqual(values.at(-1), { url: "https://example.test/next", loading: false, history, restored: { url: "https://example.test/" } });
  assert.equal(location.read().url, "https://example.test/later");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startUnloadProbe } from "../fixtures/memory-saver/unload-probe/ui/unload-probe.js";

const manifestPath = fileURLToPath(new URL("../fixtures/memory-saver/unload-probe/plugin.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// The declared UI snapshot ingress joins the plugin id and the status of a snapshot and reports a status that the plugin does
// not declare (docs/spec/declared-ui.md), so each snapshot of the probe names a declared status by its plugin-local name.
test("the unload probe registers its qualified status and pushes snapshots under the plugin-local name", { timeout: 1000 }, async () => {
  const declared = manifest.exposes.status.map((status) => status.name);
  const registered = [];
  const pushed = [];
  let onState;
  const bridge = {
    calls: { request: async (name) => (name === "tab.state.read" ? { url: "https://example.test/" } : null) },
    composition: { create: async () => ({ region: () => ({ onState: (listener) => { onState = listener; }, load: async () => {} }) }) },
    commands: { register: async () => {} },
    exposure: { register: async (kind, name) => registered.push([kind, name]) },
    snapshots: { push: (status) => pushed.push(status) },
  };

  await startUnloadProbe({ bridge, document: { getElementById: () => ({}) } });
  onState({ url: "https://example.test/next", loading: false, history: { entries: [], index: -1 } });

  assert.deepEqual(registered, [["status", "probeunload.location"]]);
  assert.ok(pushed.length === 2, `the probe pushed ${pushed.length} snapshots`);
  for (const status of pushed) {
    assert.ok(declared.includes(`${manifest.id}.${status}`),
      `the snapshot status ${status} is not a local name of a declared status (${declared.join(", ")})`);
  }
});

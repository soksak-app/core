import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateExposes, validateManifest } from "@soksak/plugin-api";
import { startRafProbe } from "../fixtures/plugin-host-throttle/raf-probe/ui/raf-probe.js";

const manifestPath = fileURLToPath(new URL("../fixtures/plugin-host-throttle/raf-probe/plugin.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

test("plugin-host RAF fixture manifest uses the public plugin exposure contract", { timeout: 1000 }, () => {
  assert.equal(validateManifest(manifest), manifest);
  assert.equal(validateExposes(manifest.id, manifest.exposes), manifest.exposes);
});

test("plugin-host RAF fixture registers a qualified status and pushes its local snapshot key", { timeout: 1000 }, async () => {
  const calls = [];
  let read;
  let now = 100;
  const bridge = {
    exposure: { register: async (...args) => calls.push(["register", ...args]) },
    commands: { register: async (name, handler) => { calls.push(["command", name]); read = handler; } },
    snapshots: { push: (...args) => calls.push(["snapshot", ...args]) },
  };
  const requestAnimationFrame = (callback) => { calls.push(["raf", callback]); };
  const performance = { now: () => now++, timeOrigin: 1000 };

  await startRafProbe({ bridge, requestAnimationFrame, performance });
  assert.equal(calls[0][0], "raf");
  assert.equal(typeof calls[0][1], "function");
  assert.deepEqual(calls[1], ["register", "status", "probehostraf.sample"]);
  assert.deepEqual(calls[2], ["command", "probehostraf.read"]);
  assert.deepEqual(calls[3], ["snapshot", "sample", { frames: 0, performanceNow: 100, timeOrigin: 1000 }]);

  const result = read();
  assert.deepEqual(result, { frames: 0, performanceNow: 101, timeOrigin: 1000 });
  assert.deepEqual(calls[4], ["snapshot", "sample", result]);
});

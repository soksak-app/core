import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateExposes, validateManifest } from "@soksak/plugin-api";
import { createRafProbeBridgeOptions } from "../fixtures/plugin-host-throttle/raf-probe/ui/bridge-report.js";

const manifestPath = fileURLToPath(new URL("../fixtures/plugin-host-throttle/raf-probe/plugin.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

test("plugin-host RAF fixture manifest uses the public plugin exposure contract", { timeout: 1000 }, () => {
  assert.equal(validateManifest(manifest), manifest);
  assert.equal(validateExposes(manifest.id, manifest.exposes), manifest.exposes);
});

test("plugin-host RAF reporter ignores open-call metrics and sends real errors to the browser hook", { timeout: 1000 }, async () => {
  const runtimeErrors = [];
  const browserErrors = [];
  const consoleCalls = [];
  const handler = { postMessage() {} };
  const bridgeOptions = createRafProbeBridgeOptions({
    handler,
    runtimeError: async (where, text) => runtimeErrors.push({ where, text }),
    reportError: (error) => browserErrors.push(error),
    console: {
      debug: (...args) => consoleCalls.push(["debug", ...args]),
      info: (...args) => consoleCalls.push(["info", ...args]),
      error: (...args) => consoleCalls.push(["error", ...args]),
    },
  });
  assert.equal(bridgeOptions.handler, handler, "the fixture bridge options lost the view handler");
  const reporter = bridgeOptions.report;

  reporter({ kind: "open-calls", plugin: "probehostraf", count: 1, oldestStartedAt: 12 });
  await Promise.resolve();
  assert.deepEqual(runtimeErrors, []);
  assert.deepEqual(browserErrors, []);
  assert.equal(consoleCalls.filter(([level]) => level === "debug").length, 1);

  reporter({ kind: "skipped", count: 1 });
  reporter({ kind: "peer-lost", reason: "surface-closed" });
  assert.equal(consoleCalls.filter(([level]) => level === "info").length, 2);
  assert.deepEqual(browserErrors, []);

  reporter({ kind: "error", where: "probehostraf.read", text: "sample failed" });
  assert.equal(browserErrors.length, 1);
  assert.equal(browserErrors[0].message, "probehostraf.read: sample failed");
});

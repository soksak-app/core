// The one-shot diagnostic reports AppKit's current color-space facts without changing the window.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";

function stableWindowState(window) {
  return Object.fromEntries([
    "responder", "frame", "content", "scale", "key", "zoomed", "active", "children", "pageProcess",
    "controls", "webviews", "nativeSurfaces", "appDomWebviews", "documentWebviews",
  ].map((name) => [name, window[name]]));
}

function assertColorSpaceFacts(facts) {
  assert.ok(facts !== null && typeof facts === "object" && !Array.isArray(facts),
    `window color-space facts must be an object: ${JSON.stringify(facts)}`);
  assert.deepEqual(Object.keys(facts).sort(), ["iccSHA256", "name"],
    "window color-space facts must contain exactly name and iccSHA256");
  if (facts.name === null) {
    assert.equal(facts.iccSHA256, null, "a window without a backing color space must have a null ICC hash");
    return;
  }
  assert.equal(typeof facts.name, "string", "the AppKit color-space name must be a string or null");
  assert.ok(facts.name.length > 0, "the AppKit color-space name must not be empty");
  assert.ok(facts.iccSHA256 === null ||
    (typeof facts.iccSHA256 === "string" && /^[0-9a-f]{64}$/.test(facts.iccSHA256)),
    "the ICC profile fingerprint must be a lowercase SHA-256 string or null");
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: native window color-space facts are one-shot and non-mutating`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    const before = stableWindowState(await s.get("host.window"));

    const facts = await s.request("diagnostics.native.window-color-space");
    assertColorSpaceFacts(facts);
    t.diagnostic(`AppKit window color-space facts: ${JSON.stringify(facts)}`);

    const missingWindow = `missing-color-space-${app.name}`;
    await assert.rejects(
      s.request("diagnostics.native.window-color-space", { window: missingWindow }),
      (error) => error.code === 1003 && error.message.includes(`window \"${missingWindow}\" does not exist`),
      "a color-space query for an absent window must report the declared missing-window error",
    );

    const after = stableWindowState(await s.get("host.window"));
    assert.deepEqual(after, before, "the diagnostic query changed stable host.window facts");
  });
}

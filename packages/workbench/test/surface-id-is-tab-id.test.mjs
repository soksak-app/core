// The surface identifier that the host receives for a tab is the tab id, so a surface named by the host (outdated.surfaces of
// host.sidecars) is the tab id of the page (docs/spec/persistent-services.md#updates).
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerPlugin } from "../registry.js";
import { surfaceForTab, surfacePlacementsForHost } from "../surface-modules.js";

const pluginId = "fixture-surface-identifier";
registerPlugin({ id: pluginId, name: "Fixture", surface: () => ({ module: "fixture", composition: {} }) });

test("the surface of a tab is named by the tab id, and the host placement keeps that identifier", () => {
  const surface = surfaceForTab({ id: "surface-7", plugin: pluginId, params: null });
  assert.equal(surface.surfaceId, "surface-7");
  const [placement] = surfacePlacementsForHost([{ id: surface.surfaceId, surface }], null, () => "the drawn record");
  assert.equal(placement.id, "surface-7");
});

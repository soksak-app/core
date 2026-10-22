import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// A place that leaves a surface out closes the regions of that surface in the host (docs/spec/native-surfaces.md), so the
// page releases the module only after the place succeeded and does not detach those regions; a failed place releases
// nothing, so the tab stays mounted.
test("a surface is released only after the place that leaves it out succeeds, without a region detach", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  // Observation starts in the next animation frame, and this test does not advance frames.
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  Object.defineProperty(dom.window, "visualViewport", { value: { width: 800, height: 600 } });
  const calls = [];
  globalThis.surfacePlaceRelease = calls;
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    // Records the region detaches that go to the host; no host event arrives.
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: () => () => {}, call: async (name, payload) => {
        if (name === "imageDetach") calls.push(`imageDetach ${payload.name}`);
        return null;
      } } };
    },
  } });
  const { mountSurface, mountedSurface, authorizeSurface, placeSurfaces } = await import("../surface-modules.js?place-release");
  const pluginId = "fixture-place-release";
  const surfaceId = "fixture-place-release-surface";
  recordOrigin(surfaceId, null);
  registerPlugin({ id: pluginId, surface: () => null });
  const module = `data:text/javascript,${encodeURIComponent(`export async function mount(root, context) {
    root.innerHTML = "<div id=view></div>";
    const composition = await context.composition.create({ regions: { view: root.querySelector("#view") } });
    return { async dispose() {
      globalThis.surfacePlaceRelease.push("module dispose");
      await composition.dispose();
    } };
  }`)}`;
  const surface = { module, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "hybrid", regions: [{ name: "view", kind: "image", sidecar: "fixture-sidecar", input: "dom" }],
      overlays: [] } };
  try {
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    // A failed place releases nothing: the surface stays mounted.
    await assert.rejects(placeSurfaces(async () => { throw new Error("host.place refused the layout"); },
      { retain: new Set(), unload: [surfaceId] }), /host.place refused the layout/);
    assert.notEqual(mountedSurface(surfaceId), null);
    assert.deepEqual(calls, []);
    // A place that succeeds releases the surface it left out, and the host already closed its regions.
    assert.equal(await placeSurfaces(async () => "placed", { retain: new Set(), unload: [surfaceId] }), "placed");
    assert.equal(mountedSurface(surfaceId), null);
    assert.deepEqual(calls, ["module dispose"]);
  } finally {
    delete globalThis.surfacePlaceRelease;
    dom.window.close();
  }
});

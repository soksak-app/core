import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// When a surface released in the same document is mounted again with the same id, the layout of the new composition must send a revision larger than the earlier layout of that
// surface. The host requires the revision to grow for each surface, and clears that value only when the surface is destroyed or the document changes.
test("a surface mounted again in the same document continues its composition revisions", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  // Observation starts in the next animation frame, and this test does not advance frames.
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const placed = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    // Records only the calls that go to the host, and uses the real surface runtime for the rest.
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, call: async (name, payload) => {
        if (name === "compositionPlace") placed.push(payload.revision);
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, disposeSurfacesExcept } = await import("../surface-modules.js?composition-revision");
  const pluginId = "fixture-composition-revision";
  const surfaceId = "fixture-composition-revision-surface";
  recordOrigin(surfaceId, null);
  registerPlugin({ id: pluginId, surface: () => null });
  const module = `data:text/javascript,${encodeURIComponent(`export async function mount(root, context) {
    const composition = await context.composition.create({});
    await composition.update(() => {});
    return { dispose: () => composition.dispose() };
  }`)}`;
  const surface = { module, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "hybrid", regions: [], overlays: [] } };
  const slot = document.querySelector("#slot");
  try {
    authorizeSurface(surfaceId);
    await mountSurface(slot, surface);
    await disposeSurface(surfaceId);
    authorizeSurface(surfaceId);
    await mountSurface(slot, surface);
    // Even when a tab is closed and opened again with the same id (restoring a stored tab), the number continues.
    await disposeSurfacesExcept(new Set());
    authorizeSurface(surfaceId);
    await mountSurface(slot, surface);
    assert.equal(placed.length, 6, `placements ${JSON.stringify(placed)}`);
    for (let i = 1; i < placed.length; i++) {
      assert.ok(placed[i] > placed[i - 1], `revision ${placed[i]} after ${placed[i - 1]}: ${JSON.stringify(placed)}`);
    }
    await disposeSurface(surfaceId);
  } finally {
    dom.window.close();
  }
});

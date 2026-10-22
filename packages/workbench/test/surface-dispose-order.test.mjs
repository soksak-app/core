import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// When a surface is removed, the workbench detaches the region of that surface before the dispose of the module. The dispose of the module ends the sidecar session,
// and the provider releases the transport image when it ends the session. If the session ends while the region is attached, the host tries to present an already sent frame
// as the released image and fails with notFound (F60). If the region is detached first, that frame is answered as stale.
test("removing a surface detaches its regions before the module ends its sidecar session", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  // Observation starts in the next animation frame, and this test does not advance frames.
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  // The margin of a region is measured with the viewport size. This test does not use sizes.
  Object.defineProperty(dom.window, "visualViewport", { value: { width: 800, height: 600 } });
  const order = [];
  globalThis.surfaceDisposeOrder = order;
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    // Records only the region detach that goes to the host, and no host event arrives. The rest of the surface runtime is the real one.
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: () => () => {}, call: async (name, payload) => {
        if (name === "imageDetach") order.push(`imageDetach ${payload.name}`);
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?dispose-order");
  const pluginId = "fixture-dispose-order";
  const surfaceId = "fixture-dispose-order-surface";
  recordOrigin(surfaceId, null);
  registerPlugin({ id: pluginId, surface: () => null });
  // Like a providing plugin, the module first ends the sidecar session in dispose and then releases the composition.
  const module = `data:text/javascript,${encodeURIComponent(`export async function mount(root, context) {
    root.innerHTML = "<div id=view></div>";
    const composition = await context.composition.create({ regions: { view: root.querySelector("#view") } });
    return { async dispose() {
      globalThis.surfaceDisposeOrder.push("session close");
      await composition.dispose();
    } };
  }`)}`;
  const surface = { module, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "hybrid", regions: [{ name: "view", kind: "image", sidecar: "fixture-sidecar", input: "dom" }],
      overlays: [] } };
  try {
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await disposeSurface(surfaceId);
    assert.deepEqual(order, ["imageDetach view", "session close"]);
  } finally {
    delete globalThis.surfaceDisposeOrder;
    dom.window.close();
  }
});

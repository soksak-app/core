import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// A place that leaves a surface out removes the composition of that surface in the host (docs/spec/native-surfaces.md), and
// the page releases the surface only after the place replies. A geometry change in between, such as the layout change that
// the place itself makes, must not send a composition place of that surface, which the host refuses with
// `surface "<id>" has no composition declaration`. A failed place resumes the composition, which places its geometry again.
test("a surface that a place leaves out sends no composition place while the place runs", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  // Animation frames run at once, so the observation starts at the mount and a resize places at once.
  dom.window.requestAnimationFrame = (fn) => { fn(0); return 1; };
  dom.window.cancelAnimationFrame = () => {};
  Object.defineProperty(dom.window, "visualViewport", { value: { width: 800, height: 600 } });
  const calls = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: () => () => {}, call: async (name) => {
        calls.push(name);
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, placeSurfaces } = await import("../surface-modules.js?place-left-out");
  const pluginId = "fixture-place-left-out";
  const surfaceId = "fixture-place-left-out-surface";
  registerPlugin({ id: pluginId, surface: () => null });
  const module = `data:text/javascript,${encodeURIComponent(`export async function mount(root, context) {
    root.innerHTML = "<div id=view></div>";
    const composition = await context.composition.create({ regions: { view: root.querySelector("#view") } });
    return { dispose: () => composition.dispose() };
  }`)}`;
  const surface = { module, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "hybrid", regions: [{ name: "view", kind: "image", sidecar: "fixture-sidecar", input: "dom" }],
      overlays: [] } };
  try {
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    const placing = (result) => async () => {
      const before = calls.length;
      dom.window.dispatchEvent(new dom.window.Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      during.push(...calls.slice(before));
      if (result instanceof Error) throw result;
      return result;
    };
    const during = [];
    // A failed place sends nothing while it runs and resumes the composition after it.
    const start = calls.length;
    await assert.rejects(placeSurfaces(placing(new Error("host.place refused the layout")), { retain: new Set(), unload: [] }),
      /host.place refused the layout/);
    assert.deepEqual(during.filter((name) => name === "compositionPlace"), [],
      `host calls while the failed place that leaves the surface out runs: ${JSON.stringify(during)}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls.slice(start).filter((name) => name === "compositionPlace"), ["compositionPlace"],
      `the composition did not place once again after the failed place: ${JSON.stringify(calls.slice(start))}`);
    during.length = 0;
    assert.equal(await placeSurfaces(placing("placed"), { retain: new Set(), unload: [] }), "placed");
    assert.deepEqual(during.filter((name) => name === "compositionPlace"), [],
      `host calls while the place that leaves the surface out runs: ${JSON.stringify(during)}`);
  } finally {
    dom.window.close();
  }
});


import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// After a render, the surface focus waits for the module preparation and the host presentation. If the tab closes in between and the surface is released, the test does not call the
// focus of the released module and answers that focus was not given. The drawing region of a released module refuses focus (F91).
test("a surface removed while its focus waits for presentation takes no focus", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  Object.defineProperty(dom.window, "visualViewport", { value: { width: 800, height: 600 } });
  const calls = [];
  globalThis.surfaceFocusCalls = calls;
  let presented;
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    // The host presentation waits until the test ends it.
    surfaces: { ...actualHost.surfaces, waitPresented: () => new Promise((resolve) => { presented = resolve; }) },
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: () => () => {}, call: async (name) => {
        calls.push(name);
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, focusSurface } = await import("../surface-modules.js?focus-dispose");
  const pluginId = "fixture-focus-dispose";
  const surfaceId = "fixture-focus-dispose-surface";
  registerPlugin({ id: pluginId, surface: () => null });
  // The module passes focus to the drawing region, like a terminal.
  const module = `data:text/javascript,${encodeURIComponent(`export async function mount(root, context) {
    root.innerHTML = "<div id=view></div>";
    const composition = await context.composition.create({ regions: { view: root.querySelector("#view") } });
    const image = composition.region("view");
    return { focus: () => image.focus(), dispose: () => composition.dispose() };
  }`)}`;
  const surface = { module, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "hybrid", regions: [{ name: "view", kind: "image", sidecar: "fixture-sidecar", input: "dom" }],
      overlays: [] } };
  try {
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    const focused = focusSurface(surfaceId);
    // Proceeds until focusSurface starts to wait for the host presentation.
    while (!presented) await new Promise((resolve) => setImmediate(resolve));
    await disposeSurface(surfaceId);
    presented();
    assert.equal(await focused, false, "a removed surface was reported as focused");
    assert.equal(calls.includes("imageFocus"), false, "the removed module's image region was asked for focus");
  } finally {
    delete globalThis.surfaceFocusCalls;
    dom.window.close();
  }
});

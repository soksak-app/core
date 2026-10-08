import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// A dom composition is declared by plugin.json and has no native region, so its module has no reason to create a
// composition. A core command waits for the declared composition of each surface it names; for a dom surface that
// wait ends when the module has mounted (docs/spec/surface-composition.md#declaration).
test("the composition of a dom surface is declared when its module mounts without creating one", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const calls = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, call: async (name) => { calls.push(name); return null; } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?dom-composition");
  const pluginId = "fixture-dom-composition";
  const surfaceId = "fixture-dom-composition-surface";
  registerPlugin({ id: pluginId, surface: () => null });
  const module = `data:text/javascript,${encodeURIComponent(`export function mount(root, context) {
    root.textContent = "text";
    context.status.report("ready");
    return { dispose() {} };
  }`)}`;
  const surface = { module, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "dom" } };
  try {
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.deepEqual(calls.filter((name) => name.startsWith("composition")), []);
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

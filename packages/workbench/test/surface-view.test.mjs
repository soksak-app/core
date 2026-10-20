import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// A view surface has no module: the host loads its page into the view. Mounting it imports nothing and declares its view composition
// (docs/spec/plugins.md#view-surfaces), so a core command that waits for the declaration of the surface does not wait for a module.
test("mounting a view surface imports no module and declares its view composition", { timeout: 5000 }, async (t) => {
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
      return { ...runtime, native: { ...runtime.native, call: async (name, payload) => {
        calls.push({ name, payload });
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view");
  const pluginId = "fixture-view";
  const surfaceId = "fixture-view-surface";
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  try {
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.deepEqual(calls.filter(({ name }) => name === "compositionDeclare"), [{
      name: "compositionDeclare", payload: { plugin: pluginId, composition },
    }]);
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

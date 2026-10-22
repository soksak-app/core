import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// Closing a tab removes its surface at once, also while its module has not finished mounting; a mount that ends later
// disposes its module (docs/spec/plugins.md#surface-module-ownership).
test("a surface whose module has not finished mounting is disposed without waiting for the mount", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, call: async () => null } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?dispose-pending");
  const pluginId = "fixture-dispose-pending";
  const surfaceId = "fixture-dispose-pending-surface";
  recordOrigin(surfaceId, null);
  registerPlugin({ id: pluginId, surface: () => null });
  // The module reports that its mount started through globalThis.mountStarted and waits for globalThis.finishMount, which the test
  // calls after the surface is gone. The test waits for the report, so a mount that never starts ends the test at its limit.
  const module = `data:text/javascript,${encodeURIComponent(`export async function mount(root) {
    root.textContent = "starting";
    globalThis.mountStarted();
    await new Promise((resolve) => { globalThis.finishMount = resolve; });
    return { dispose() { globalThis.disposedModule = true; } };
  }`)}`;
  const surface = { module, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "dom" } };
  const started = new Promise((resolve) => { globalThis.mountStarted = resolve; });
  try {
    authorizeSurface(surfaceId);
    const mounting = mountSurface(document.querySelector("#slot"), surface);
    await started;
    await disposeSurface(surfaceId);
    assert.equal(document.querySelector("#slot").textContent, "", "the surface is removed before its mount ends");
    globalThis.finishMount();
    assert.equal(await mounting, null);
    assert.equal(globalThis.disposedModule, true, "a mount that ends after the close disposes its module");
  } finally {
    delete globalThis.mountStarted;
    delete globalThis.finishMount;
    delete globalThis.disposedModule;
    dom.window.close();
  }
});

// A view tab whose stored origin is refused does not start its view, and mounting it does not throw: the refusal is shown on the tab
// (docs/spec/projects.md#tab-origin).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { restoreOrigin, viewRefusal } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

test("mounting a view whose stored origin is refused leaves the view out and does not throw", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const started = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async () => () => {}, call: async (name) => {
        if (name === "viewReply") started.push(name);
        return null;
      } } };
    },
  } });
  const actualProjects = await import("../projects.js");
  t.mock.module("../projects.js", { exports: { ...actualProjects, active: () => null, tabStateStore: () => null, tabStatesReady: async () => null } });
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-refused");
  const pluginId = "fixture-refused-view";
  const surfaceId = "tab-refused-view";
  // The stored tab of this view has no origin member: the layout read refuses it and keeps the text on the tab.
  restoreOrigin({ id: surfaceId, plugin: pluginId }, true);
  assert.notEqual(viewRefusal(surfaceId), null, "the layout read refused the view tab");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  try {
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface, { onState: () => {} });
    assert.equal(document.querySelectorAll("#slot .surface-module-host").length, 0, "the view of a refused tab was started");
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

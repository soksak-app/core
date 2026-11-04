// Checks that a section surface mounts without a tab origin: no tab opened the section, so its context origin records no
// directory, as its start values do (docs/spec/native-surfaces.md#view-surfaces).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { seedSourceOrigins } from "../source-origins.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

test("a section surface mounts with an origin that records no directory", { timeout: 5000 }, async (t) => {
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
      return { ...runtime, native: { ...runtime.native, on: async () => () => {}, call: async () => null } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?section-mount");
  const pluginId = "fixture-section-plugin";
  const surfaceId = "spc-aaaaaa/left/fixture-section-plugin.tree";
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], element: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/tree.html" }, params: null, diagnostics: null, unload: false,
    section: { id: "fixture-section-plugin.tree", sidebar: "left", card: null } };
  try {
    authorizeSurface(surfaceId);
    seedSourceOrigins({ floor: 1, views: { [surfaceId]: 1 } });
    await mountSurface(document.querySelector("#slot"), surface);
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

test("a surface that a new drawing mounts again reports its state to the new drawing", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=first></div><div id=second></div></main>", { url: "http://localhost/" });
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
      return { ...runtime, native: { ...runtime.native, on: async () => () => {}, call: async () => null } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?section-remount");
  const pluginId = "fixture-redrawn-plugin";
  const surfaceId = "spc-aaaaaa/right/fixture-redrawn-plugin.tabs";
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], element: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/tabs.html" }, params: null, diagnostics: null, unload: false,
    section: { id: "fixture-redrawn-plugin.tabs", sidebar: "right", card: null } };
  const earlier = [];
  const later = [];
  try {
    authorizeSurface(surfaceId);
    seedSourceOrigins({ floor: 1, views: { [surfaceId]: 1 } });
    await mountSurface(document.querySelector("#first"), surface, { onState: (state) => earlier.push(state.phase) });
    const phase = earlier.at(-1);
    assert.ok(phase, "the first drawing received no state");
    const count = earlier.length;
    await mountSurface(document.querySelector("#second"), surface, { onState: (state) => later.push(state.phase) });
    assert.deepEqual(later, [phase], "the new drawing received the current state");
    assert.equal(earlier.length, count, "the earlier drawing no longer receives states");
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

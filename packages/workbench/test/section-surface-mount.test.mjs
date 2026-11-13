// Checks that a section surface mounts without a tab origin: no tab opened the section, so its context origin records no
// directory, as its start values do (docs/spec/native-surfaces.md#view-surfaces).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

// The host calls of the mount are answered by the page-wire case of each test (docs/spec/cases/page-wire/README.md). A case is selected
// before the first module that imports host.js is imported, because host.js reads the host when it is imported.
const firstWire = selectPageWire("section-surface-mount-declare");
const { registerPlugin } = await import("../registry.js");
const { seedSourceOrigins } = await import("../source-origins.js");
const { setSurfaceTextSize } = await import("../text-size.js");

setSurfaceTextSize(() => 1);

test("a section surface mounts with an origin that records no directory", { timeout: 5000 }, async () => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
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
  firstWire.finish();
});

test("a surface that a new drawing mounts again reports its state to the new drawing", { timeout: 5000 }, async () => {
  const wire = selectPageWire("section-surface-mount-remount");
  const dom = new JSDOM("<main><div id=first></div><div id=second></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
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
  wire.finish();
});

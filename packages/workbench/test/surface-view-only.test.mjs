// The workbench mounts only a view surface: a surface of any other composition is refused before a placeholder or an import, and the
// hidden surface hosts leave the document without a parking fragment (docs/spec/plugins.md#surface-ownership).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

registerPlugin({ id: "fixture-view", name: "Probe", surface: () => null });
const { setSurfaceTextSize } = await import("../text-size.js");
setSurfaceTextSize(() => 1);

const moduleUrl = "data:text/javascript,export function mount(){globalThis.surfaceModuleMounted=true;return {dispose(){}}}";

test("a surface of a composition other than view is refused and its module is not imported", async () => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { mountSurface } = await import("../surface-modules.js");
  globalThis.surfaceModuleMounted = false;
  await assert.rejects(
    mountSurface(document.querySelector("#slot"), {
      module: moduleUrl, surfaceId: "tab-hybrid", pluginId: "fixture-view", sidecars: [],
      composition: { kind: "hybrid", regions: {}, overlays: {} },
    }),
    /surface tab-hybrid requires a view composition/,
  );
  assert.equal(globalThis.surfaceModuleMounted, false, "the module was imported");
  assert.equal(document.querySelector("#slot").children.length, 0, "a refused surface leaves an element in the slot");
  dom.window.close();
});

test("the surface module exports no parking count", async () => {
  const surfaceModules = await import("../surface-modules.js");
  assert.equal(surfaceModules.parkedElements, undefined, "the parked element count is removed with the parking fragment");
});

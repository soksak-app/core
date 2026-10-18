import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

mock.module("../projects.js", { namedExports: { active: () => null, tabStateStore: () => null, tabStatesReady: async () => null } });
mock.module("../environment.js", { namedExports: { pluginDiagnostics: async () => null } });
registerPlugin({ id: "fixture-parked", surface: () => null });
const { setSurfaceTextSize } = await import("../text-size.js");
setSurfaceTextSize(() => 1);
const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
globalThis.document = dom.window.document;
const { mountSurface, disposeSurface, parkedElements } = await import("../surface-modules.js");
const slot = document.querySelector("#slot");

// A surface that draws a list of three items in its shadow root.
const MODULE = `data:text/javascript,${encodeURIComponent(`export function mount(root) {
  const list = document.createElement("ul");
  for (let i = 0; i < 3; i++) list.append(document.createElement("li"));
  root.append(list);
  return { dispose() { root.replaceChildren(); } };
}`)}`;
const surface = (surfaceId) => ({ module: MODULE, surfaceId, pluginId: "fixture-parked", unload: false, composition: { kind: "dom" }, declarations: {}, sidecars: [] });

test("parkedElements counts the elements of the parked surface hosts and their shadow roots, and the page reads it", async () => {
  await mountSurface(slot, surface("parked-a"));
  assert.equal(parkedElements(), 0);
  // Mounting another surface in the same slot parks the first host outside the document.
  await mountSurface(slot, surface("parked-b"));
  assert.equal(document.querySelectorAll('[data-surface="parked-a"]').length, 0);
  // The host, the list and its three items.
  assert.equal(parkedElements(), 5);
  assert.equal(globalThis.__soksakParkedElements, parkedElements);
  await disposeSurface("parked-a");
  assert.equal(parkedElements(), 0);
  await disposeSurface("parked-b");
  dom.window.close();
});

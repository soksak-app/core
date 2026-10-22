import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { openTabStates } from "../tab-state.js";

// The page draws the first plane before projects.initialise opens the tab state store; the test holds the open until the
// surface has started to mount.
const UNLOAD = { format: 1, maxBytes: 64 };
let store = null;
let opened;
const tried = new Promise((resolve) => { opened = resolve; });
mock.module("../projects.js", { namedExports: { active: () => null, tabStateStore: () => store, tabStatesReady: () => tried } });
mock.module("../environment.js", { namedExports: { pluginDiagnostics: async () => null } });
const reported = [];
globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };
registerPlugin({ id: "fixture-early", surface: () => null });
const { setSurfaceTextSize } = await import("../text-size.js");
setSurfaceTextSize(() => 1);

test("a declaring surface mounted before the tab state store opens keeps its state and label", async () => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { mountSurface, disposeSurface } = await import("../surface-modules.js");
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`export function mount(root, context) {
    context.tab.title("Early");
    context.tab.state.write({ page: 4 });
    return { dispose() {} };
  }`)}`;
  recordOrigin("tab-early", null);
  const mounting = mountSurface(document.querySelector("#slot"), { module: moduleUrl, surfaceId: "tab-early",
    pluginId: "fixture-early", unload: UNLOAD, composition: { kind: "dom" }, declarations: {}, sidecars: [] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  store = await openTabStates({ store: { tabState: async () => null, tabStatePut: async () => 0 },
    failed: (error) => { throw error; }, unloadOf: () => UNLOAD });
  opened();
  await mounting;
  assert.deepEqual(reported, []);
  assert.deepEqual(store.entry("tab-early").state, { format: 1, value: { page: 4 } });
  assert.equal(store.label("tab-early"), "Early");
  await disposeSurface("tab-early");
  dom.window.close();
});

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { openTabStates } from "../tab-state.js";

// The tab state store of the memory saver is opened by projects.initialise; the consumer test opens it over a fake store.
const UNLOAD = { format: 2, maxBytes: 64 };
const store = await openTabStates({
  store: { tabState: async () => null, tabStatePut: async () => 0 },
  failed: (error) => { throw error; },
  unloadOf: (plugin) => (plugin === "fixture-unload" ? UNLOAD : false),
});
mock.module("../projects.js", { namedExports: { active: () => null, tabStateStore: () => store, tabStatesReady: async () => store } });
mock.module("../environment.js", { namedExports: { pluginDiagnostics: async () => null } });
const reported = [];
globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };
for (const id of ["fixture-unload", "fixture-plain"]) registerPlugin({ id, surface: () => null });
const { setSurfaceTextSize } = await import("../text-size.js");
setSurfaceTextSize(() => 1);
const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
globalThis.document = dom.window.document;
const { mountSurface, disposeSurface } = await import("../surface-modules.js");
const reports = await import("../tab-reports.js");
const slot = document.querySelector("#slot");

const MODULE = `data:text/javascript,${encodeURIComponent(`export function mount(root, context) {
  globalThis.contexts ??= {};
  globalThis.contexts[context.surfaceId] = context;
  return { dispose() {} };
}`)}`;
// The tab creation of the workbench records the origin of each tab (docs/spec/projects.md#tab-origin); a mount reads it, so the fixture records it.
const surface = (surfaceId, pluginId = "fixture-unload", unload = UNLOAD) => {
  reports.recordOrigin(surfaceId, null);
  return { module: MODULE, surfaceId, pluginId, unload, composition: { kind: "dom" }, declarations: {}, sidecars: [] };
};

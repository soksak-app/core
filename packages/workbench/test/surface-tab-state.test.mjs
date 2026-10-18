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
const surface = (surfaceId, pluginId = "fixture-unload", unload = UNLOAD) =>
  ({ module: MODULE, surfaceId, pluginId, unload, composition: { kind: "dom" }, declarations: {}, sidecars: [] });

test("a declaring surface writes its tab state and reads it back, and refusals name the tab", async () => {
  await mountSurface(slot, surface("tab-state-a"));
  const { state } = globalThis.contexts["tab-state-a"].tab;
  assert.equal(state.read(), null);
  state.write({ page: 3 });
  assert.deepEqual(store.entry("tab-state-a").state, { format: 2, value: { page: 3 } });
  assert.deepEqual(state.read(), { page: 3 });
  assert.throws(() => state.write({ text: "x".repeat(100) }), /tab tab-state-a state of 111 bytes exceeds 64/);
  assert.throws(() => state.write(undefined), /tab tab-state-a state is not JSON/);
  assert.throws(() => state.write({ big: 1n }), /tab tab-state-a state is not JSON/);
  store.write("tab-state-a", { format: 1, value: {} });
  assert.throws(() => state.read(), /tab tab-state-a state format 1 is not 2/);
  await disposeSurface("tab-state-a");
});

test("a surface whose plugin does not declare surface.unload has no tab state", async () => {
  await mountSurface(slot, surface("tab-state-plain", "fixture-plain", false));
  assert.equal(globalThis.contexts["tab-state-plain"].tab.state, undefined);
  await disposeSurface("tab-state-plain");
});

test("a write from a disposed context is refused and logged once", async () => {
  await mountSurface(slot, surface("tab-state-old"));
  const { state } = globalThis.contexts["tab-state-old"].tab;
  state.write({ page: 1 });
  await disposeSurface("tab-state-old", { mode: "unload" });
  reported.length = 0;
  state.write({ page: 9 });
  state.write({ page: 10 });
  assert.deepEqual(reported, ["tab tab-state-old state write refused: disposed"]);
  assert.deepEqual(store.entry("tab-state-old").state, { format: 2, value: { page: 1 } });
});

test("keep busy protects the tab until the surface is disposed, and keep modified follows the modified report", async () => {
  await mountSurface(slot, surface("tab-keep"));
  const { tab } = globalThis.contexts["tab-keep"];
  tab.keep("busy", true);
  tab.modified(true);
  assert.deepEqual(reports.tabKeeps("tab-keep"), ["keep:modified", "keep:busy"]);
  tab.keep("busy", false);
  assert.deepEqual(reports.tabKeeps("tab-keep"), ["keep:modified"]);
  tab.keep("busy", true);
  assert.throws(() => tab.keep("other", true), /unknown keep reason: other/);
  assert.throws(() => tab.keep("busy", 1), /keep busy must be true or false/);
  await disposeSurface("tab-keep", { mode: "unload" });
  assert.deepEqual(reports.tabKeeps("tab-keep"), ["keep:modified"]);
  reports.reportModified("tab-keep", false);
});

test("the unload mode keeps the tab reports except the error, and the close mode clears them", async () => {
  for (const [id, mode] of [["tab-unload", "unload"], ["tab-close", undefined]]) {
    reports.recordOrigin(id, null);
    await mountSurface(slot, surface(id));
    const { tab } = globalThis.contexts[id];
    tab.title("Doc");
    tab.footer("foot");
    tab.notify("done");
    tab.error("failed");
    await disposeSurface(id, mode === undefined ? undefined : { mode });
  }
  assert.equal(reports.tabLabel("tab-unload"), "Doc");
  assert.equal(reports.tabFooter("tab-unload"), "foot");
  assert.equal(reports.tabNotice("tab-unload"), "done");
  assert.notEqual(reports.tabOrigin("tab-unload"), reports.tabOrigin("tab-never"));
  assert.equal(reports.tabError("tab-unload"), null);
  assert.deepEqual([reports.tabLabel("tab-close"), reports.tabFooter("tab-close"), reports.tabNotice("tab-close"), reports.tabError("tab-close")],
    [null, null, null, null]);
  await assert.rejects(disposeSurface("tab-unload", { mode: "other" }), /unknown dispose mode: other/);
});

test("a mount waits for a pending dispose of the same tab and creates a new surface", async () => {
  await mountSurface(slot, surface("tab-again"));
  const first = globalThis.contexts["tab-again"];
  const disposing = disposeSurface("tab-again", { mode: "unload" });
  await mountSurface(slot, surface("tab-again"));
  await disposing;
  const second = globalThis.contexts["tab-again"];
  assert.notEqual(first, second);
  assert.equal(second.closing.aborted, false);
  assert.equal(slot.querySelectorAll('[data-surface="tab-again"]').length, 1);
  await disposeSurface("tab-again");
});

test("a title report of a declaring surface writes the label cache", async () => {
  await mountSurface(slot, surface("tab-label"));
  globalThis.contexts["tab-label"].tab.title("Cached");
  assert.equal(store.label("tab-label"), "Cached");
  globalThis.contexts["tab-label"].tab.title(null);
  assert.equal(store.label("tab-label"), null);
  await disposeSurface("tab-label");
  dom.window.close();
});

test("each mount reports its end to the mount listeners, with the error of a failed mount", async () => {
  const { onSurfaceMounted } = await import("../surface-modules.js");
  const ended = [];
  const off = onSurfaceMounted((id, error) => ended.push([id, error?.message ?? null]));
  await mountSurface(slot, surface("tab-mount-ok"));
  const failing = `data:text/javascript,${encodeURIComponent("export function mount() { throw new Error('mount refused'); }")}`;
  await assert.rejects(mountSurface(slot, { ...surface("tab-mount-bad"), module: failing }), /mount refused/);
  off();
  assert.deepEqual(ended, [["tab-mount-ok", null], ["tab-mount-bad", "mount refused"]]);
  await disposeSurface("tab-mount-ok");
  await disposeSurface("tab-mount-bad");
});

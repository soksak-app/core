// A view that declares surface.unload reads its tab state while the page is still opening the tab state store (projects.initialise):
// its calls wait for the store to be tried, so the first call of the view does not fail with "the tab state store is not open", and
// a title and a state that the view sends meanwhile reach the store once it opens.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";

// The host calls of the page are answered by the page-wire case (docs/spec/cases/page-wire/README.md). The case is selected before the
// first module that imports host.js is imported, because host.js reads the host when it is imported.
const wire = selectPageWire("surface-view-tab-state-open");
const { registerPlugin } = await import("../registry.js");
const { registerSourceOrigin } = await import("../source-origins.js");
const { recordOrigin } = await import("../tab-reports.js");
const { setSurfaceTextSize } = await import("../text-size.js");
const { HostWorkspaceStore } = await import("../host-store.js");
const projects = await import("../projects.js");
const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js");

setSurfaceTextSize(() => 1);
// projects.initialise reads the project parameter of the address of the window.
globalThis.location = new URL("http://soksak.test/index.html");

test("a view call of a surface with surface.unload waits for the tab state store to open", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const pluginId = "fixture-tab-state-view";
  const surfaceId = "fixture-tab-state-view-surface";
  const unload = { format: 2, maxBytes: 64 };
  // The host holds the reply of the tab state read until the test releases it, so the store is not open while the page is initialising.
  const initialising = projects.initialise(new HostWorkspaceStore(host), (plugin) => (plugin === pluginId ? unload : false));
  // The initialisation reads the registry and then asks for the tab state; the end of the microtask queue follows both calls.
  await drained();
  assert.deepEqual(wire.calls.map(({ name, payload }) => [name, payload.kind]), [["workspace", "snapshot"], ["workspace", "tabState"]]);
  recordOrigin(surfaceId, null, "test fixture");
  registerSourceOrigin(pluginId, surfaceId, 1);
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, unload, declarations: { status: [], commands: [], element: [] }, sidecars: [], composition };
  try {
    authorizeSurface(surfaceId);
    const mounted = mountSurface(document.querySelector("#slot"), surface, { onState: () => {} });
    const reported = [];
    const originalDispatchEvent = globalThis.dispatchEvent;
    globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };
    t.after(() => { globalThis.dispatchEvent = originalDispatchEvent; });
    // The three calls of the view reach the listener that the mount installed, in the order of the notices of the case.
    wire.deliverNotice();
    wire.deliverNotice();
    wire.deliverNotice();
    // A call runs in microtasks until it waits for the tab state store, so after the end of the microtask queue a call that did not
    // wait for the store has replied.
    await drained();
    assert.deepEqual(wire.calls.filter(({ name }) => name === "viewReply"), [], "a call was answered before the tab state store opened");
    const beforeOpen = wire.calls.length;
    wire.release();
    await initialising;
    await mounted;
    await drained();
    const replies = wire.calls.slice(beforeOpen).filter(({ name }) => name === "viewReply").map(({ payload }) => payload);
    assert.deepEqual(wire.calls.slice(0, beforeOpen).filter(({ name }) => name === "viewReply"), [],
      "a call was answered before the tab state store opened");
    assert.deepEqual(replies.map(({ id, result, error }) => ({ id, result: result ?? null, error: error ?? null })),
      [1, 2, 3].map((id) => ({ id, result: null, error: null })));
    const store = projects.tabStateStore();
    assert.deepEqual(store.entry(surfaceId), { label: "Early", state: { format: 2, value: { page: 4 } } },
      "the title and the state sent before the store opened were not kept by the store");
    assert.deepEqual(reported, []);
    // The store writes a changed entry after its coalescing interval; the flush writes it now.
    await store.flush();
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
  wire.finish();
});

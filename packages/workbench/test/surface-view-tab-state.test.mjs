// A view that declares surface.unload reads its tab state while the page is still opening the tab state store (projects.initialise):
// its calls wait for the store to be tried, so the first call of the view does not fail with "the tab state store is not open", and
// a title and a state that the view sends meanwhile reach the store once it opens.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { registerSourceOrigin } from "../source-origins.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

test("a view call of a surface with surface.unload waits for the tab state store to open", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  // The store is not open until the test opens it, as it is not while the page is initialising.
  let storeNow = null;
  let openStore;
  const storeOpened = new Promise((resolve) => { openStore = resolve; });
  const listeners = new Map();
  let viewCallListenerReady;
  const viewCallListenerRegistered = new Promise((resolve) => { viewCallListenerReady = resolve; });
  const replies = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async (name, listener) => {
        listeners.set(name, listener);
        if (name === "view-call") viewCallListenerReady();
        return () => {};
      }, call: async (name, payload) => {
        if (name === "viewReply") replies.push(payload);
        return null;
      } } };
    },
  } });
  const actualProjects = await import("../projects.js");
  t.mock.module("../projects.js", { exports: {
    ...actualProjects,
    active: () => null,
    tabStateStore: () => storeNow,
    tabStatesReady: () => storeOpened,
    waitForInitialProjectContext: async () => {},
  } });
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-tab-state");
  const pluginId = "fixture-tab-state-view";
  const surfaceId = "fixture-tab-state-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerSourceOrigin(pluginId, surfaceId, 1);
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const unload = { format: 2, maxBytes: 64 };
  const surface = { module: null, surfaceId, pluginId, unload, declarations: { status: [], commands: [], element: [] }, sidecars: [], composition };
  try {
    authorizeSurface(surfaceId);
    const mounted = mountSurface(document.querySelector("#slot"), surface, { onState: () => {} });
    await viewCallListenerRegistered;
    const reported = [];
    const originalDispatchEvent = globalThis.dispatchEvent;
    globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };
    t.after(() => { globalThis.dispatchEvent = originalDispatchEvent; });
    const call = (id, command, params) => listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, generation: 1, id, command, params });
    call(1, "tab.state.read", null);
    call(2, "tab.title", "Early");
    call(3, "tab.state.write", { page: 4 });
    // The store is still opening: no reply of the calls has been sent.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(replies, [], "a call was answered before the tab state store opened");
    const labels = [];
    const writes = [];
    storeNow = { entry: () => null, cacheLabel: (...label) => labels.push(label), write: (...write) => writes.push(write) };
    openStore();
    await mounted;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(replies.map(({ id, result, error }) => ({ id, result: result ?? null, error: error ?? null })),
      [1, 2, 3].map((id) => ({ id, result: null, error: null })));
    assert.deepEqual(labels, [[surfaceId, pluginId, "Early"]], "the title sent before the store opened left no label");
    assert.deepEqual(writes, [[surfaceId, { format: 2, value: { page: 4 } }]], "the state sent before the store opened was not stored");
    assert.deepEqual(reported, []);
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

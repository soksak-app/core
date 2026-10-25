// The view path of a surface with a fake native host: the tab state and the tab reports that a view calls, the composition place
// of a view that a place leaves out, and the authorization that gates the composition declaration of a view. The fake host records
// each host call and delivers each view call to the view-call listener of the surface (docs/spec/native-surfaces.md#view-surfaces).
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { openTabStates } from "../tab-state.js";
import { seedSourceOrigins } from "../source-origins.js";

// The tab state store of the memory saver is opened by projects.initialise; this file opens it over a fake store.
const UNLOAD = { format: 2, maxBytes: 64 };
const store = await openTabStates({
  store: { tabState: async () => null, tabStatePut: async () => 0 },
  failed: (error) => { throw error; },
  unloadOf: (plugin) => (plugin === "fixture-unload" ? UNLOAD : false),
});
mock.module("../projects.js", { namedExports: { active: () => null, tabStateStore: () => store, tabStatesReady: async () => store,
  waitForInitialProjectContext: async () => {} } });
mock.module("../environment.js", { namedExports: { pluginDiagnostics: async () => null } });
for (const id of ["fixture-unload", "fixture-plain"]) registerPlugin({ id, surface: () => null });
const { setSurfaceTextSize } = await import("../text-size.js");
setSurfaceTextSize(() => 1);

let instance = 0;
/** Mounts the view of a surface on a fake native host and returns the view call and host call records of that host. */
async function harness(t) {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = new Map();
  const calls = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native,
        on: async (event, listener) => {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event).add(listener);
          return () => listeners.get(event).delete(listener);
        },
        call: async (name, payload) => { calls.push({ name, payload }); return null; } } };
    },
  } });
  const modules = await import(`../surface-modules.js?view-path-${++instance}`);
  let nextId = 1;
  // Sends one view call and resolves with the reply that the view receives.
  const viewCall = async (command, params) => {
    const id = nextId++;
    for (const listener of listeners.get("view-call") ?? []) listener({ id, command, params, generation: 1 });
    for (let turn = 0; turn < 100; turn += 1) {
      const reply = calls.find((call) => call.name === "viewReply" && call.payload.id === id);
      if (reply) return reply.payload;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`view call ${command} got no reply`);
  };
  return { modules, calls, viewCall, page: String(dom.window.performance.timeOrigin), slot: document.querySelector("#slot"), close: () => dom.window.close() };
}

const expectedReply = (host, id, result) => ({ id, result, page: host.page, generation: 1 });

const declarations = { status: [], commands: [], dom: [] };
const viewOf = (surfaceId, pluginId, unload) => ({
  surfaceId, pluginId, declarations, sidecars: [], unload,
  composition: { kind: "view", page: "ui/page.html", regions: [], overlays: [] },
});

test("a declaring view writes its tab state and reads it back, and refusals name the tab", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = h.modules;
  const { recordOrigin } = await import("../tab-reports.js");
  const id = "view-state-a";
  recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, pluginHosts: {}, views: { [id]: 1 } });
  authorizeSurface(id);
  await mountSurface(h.slot, viewOf(id, "fixture-unload", UNLOAD));
  await waitSurfaceCompositionDeclared(id);
  assert.deepEqual(await h.viewCall("tab.state.read"), expectedReply(h, 1, null));
  assert.deepEqual(await h.viewCall("tab.state.write", { page: 3 }), expectedReply(h, 2, null));
  assert.deepEqual(store.entry(id).state, { format: 2, value: { page: 3 } });
  assert.deepEqual(await h.viewCall("tab.state.read"), expectedReply(h, 3, { page: 3 }));
  assert.deepEqual((await h.viewCall("tab.state.write", { text: "x".repeat(100) })).error,
    { code: -32000, message: `tab ${id} state of 111 bytes exceeds 64` });
  assert.deepEqual((await h.viewCall("tab.state.write", undefined)).error,
    { code: -32000, message: `tab ${id} state is not JSON: undefined` });
  store.write(id, { format: 1, value: {} });
  assert.deepEqual((await h.viewCall("tab.state.read")).error,
    { code: -32000, message: `tab ${id} state format 1 is not 2` });
  await disposeSurface(id);
  h.close();
});

test("a view whose plugin does not declare surface.unload has no tab state", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = h.modules;
  const { recordOrigin } = await import("../tab-reports.js");
  const id = "view-state-plain";
  recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, pluginHosts: {}, views: { [id]: 1 } });
  authorizeSurface(id);
  await mountSurface(h.slot, viewOf(id, "fixture-plain", false));
  await waitSurfaceCompositionDeclared(id);
  assert.deepEqual((await h.viewCall("tab.state.read")).error,
    { code: -32000, message: "view call tab.state.read: the tab state is not declared" });
  await disposeSurface(id);
  h.close();
});

test("the tab reports of a view set its title, its modified mark and its error", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = h.modules;
  const reports = await import("../tab-reports.js");
  const id = "view-report-a";
  reports.recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, pluginHosts: {}, views: { [id]: 1 } });
  authorizeSurface(id);
  await mountSurface(h.slot, viewOf(id, "fixture-plain", false));
  await waitSurfaceCompositionDeclared(id);
  assert.deepEqual(await h.viewCall("tab.title", "Notes"), expectedReply(h, 1, null));
  assert.equal(reports.tabLabel(id), "Notes");
  assert.deepEqual(await h.viewCall("tab.modified", true), expectedReply(h, 2, null));
  assert.equal(reports.tabModified(id), true);
  assert.deepEqual(await h.viewCall("tab.error", "disk full"), expectedReply(h, 3, null));
  assert.equal(reports.tabError(id), "disk full");
  await disposeSurface(id);
  h.close();
});

test("the composition of a view places nothing while a place that leaves the view out runs", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, placeSurfaces } = h.modules;
  const reports = await import("../tab-reports.js");
  const id = "view-place-a";
  reports.recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, pluginHosts: {}, views: { [id]: 1 } });
  authorizeSurface(id);
  await mountSurface(h.slot, viewOf(id, "fixture-plain", false));
  await waitSurfaceCompositionDeclared(id);
  const placed = h.calls.filter((call) => call.name === "compositionPlace").length;
  await placeSurfaces(async () => {
    // The view runs a placement while the place that leaves it out is running: the placement is not sent.
    await h.viewCall("composition.place", { regions: [], overlays: [] });
    assert.equal(h.calls.filter((call) => call.name === "compositionPlace").length, placed, "a placement was sent while the place runs");
    return null;
  }, { retain: new Set() });
  await disposeSurface(id);
  h.close();
});

test("a view declares its composition only after the host authorizes its surface", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = h.modules;
  const reports = await import("../tab-reports.js");
  const id = "view-auth-a";
  reports.recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, pluginHosts: {}, views: { [id]: 1 } });
  const mounted = mountSurface(h.slot, viewOf(id, "fixture-plain", false));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.calls.filter((call) => call.name === "compositionDeclare").length, 0, "the view declared before authorization");
  authorizeSurface(id);
  await mounted;
  await waitSurfaceCompositionDeclared(id);
  assert.equal(h.calls.filter((call) => call.name === "compositionDeclare").length, 1);
  await disposeSurface(id);
  h.close();
});


test("a later retained mount waits for the preceding placement release", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { mountSurface, authorizeSurface, disposeSurface, mountedSurface, placeSurfaces } = h.modules;
  const { recordOrigin } = await import("../tab-reports.js");
  const id = "view-retained-placement-order";
  recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, pluginHosts: {}, views: { [id]: 1 } });
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const order = [];
  const previous = placeSurfaces(async () => {
    entered();
    await held;
    order.push("previous placed");
  }, { retain: new Set() });
  await started;
  const next = placeSurfaces(async () => {
    order.push("next prepare");
    authorizeSurface(id);
    await mountSurface(h.slot, viewOf(id, "fixture-plain", false));
  }, { retain: new Set([id]) });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([previous, next]);
    assert.deepEqual(order, ["previous placed", "next prepare"]);
    assert.equal(mountedSurface(id)?.disposed, false,
      "the preceding placement released the retained mount prepared by its successor");
  } finally {
    release();
    await Promise.allSettled([previous, next]);
    await disposeSurface(id);
    h.close();
  }
});

test("a rejected placement reports its error and allows the next placement", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const failure = new Error("fixture placement rejected");
  const rejected = h.modules.placeSurfaces(async () => { throw failure; }, { retain: new Set() });
  const following = h.modules.placeSurfaces(async () => "next placed", { retain: new Set() });
  try {
    await assert.rejects(rejected, (error) => error === failure);
    assert.equal(await following, "next placed");
  } finally {
    await Promise.allSettled([rejected, following]);
    h.close();
  }
});

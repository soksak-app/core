// The view path of a surface with a fake native host: the tab state and the tab reports that a view calls, the composition place
// and the sidecar sends of a view that a place leaves out, the release of a view and the authorization that gates the composition
// declaration of a view. The fake host records each host call and each sidecar send and delivers each view call to the view-call
// listener of the surface (docs/spec/native-surfaces.md#view-surfaces).
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { openTabStates } from "../tab-state.js";
import { endSourceOrigin, registerSourceOrigin, seedSourceOrigins } from "../source-origins.js";
import { pageIdentity } from "../page-identity.js";

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

// The region queries of the document regions: the page loads the region record once, so every harness gives it this fake.
const regionQueries = [];
const documents = {
  query: async (surface, document) => { regionQueries.push(["documentQuery", surface, document]); return { media: false, capture: false, form: false }; },
  interactionState: async (surface, document) => { regionQueries.push(["documentInteractionState", surface, document]); return "AAAA"; },
};

let instance = 0;
/**
 * Mounts the view of a surface on a fake native host and returns the view call, host call and sidecar send records of that host.
 * refuse names the host calls that the fake host refuses.
 */
async function harness(t, { refuse = new Set() } = {}) {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = new Map();
  const calls = [];
  const sent = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    documents,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native,
        on: async (event, listener) => {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event).add(listener);
          return () => listeners.get(event).delete(listener);
        },
        call: async (name, payload) => {
          calls.push({ name, payload });
          if (refuse.has(name)) throw new Error(`the host refused ${name}`);
          return null;
        } },
        // The sidecar port of the surface records each send that reaches a sidecar.
        sidecar: () => ({ send: async (id, body) => { sent.push(body); return null; }, on: async () => () => {}, onFailure: async () => () => {} }) };
    },
  } });
  const modules = await import(`../surface-modules.js?view-path-${++instance}`);
  let nextId = 1;
  // Delivers one view call and returns its id without waiting for its reply.
  const deliver = (command, params, generation = 1) => {
    const id = nextId++;
    for (const listener of listeners.get("view-call") ?? []) listener({ id, command, params, generation });
    return id;
  };
  // Sends one view call and resolves with the reply that the view receives.
  const viewCall = async (command, params, generation = 1) => {
    const id = deliver(command, params, generation);
    for (let turn = 0; turn < 100; turn += 1) {
      const reply = calls.find((call) => call.name === "viewReply" && call.payload.id === id);
      if (reply) return reply.payload;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`view call ${command} got no reply`);
  };
  return { modules, calls, sent, deliver, viewCall, page: pageIdentity, slot: document.querySelector("#slot"), close: () => dom.window.close() };
}

const expectedReply = (host, id, result) => ({ id, result, page: host.page, generation: 1 });

const declarations = { status: [], commands: [], element: [] };
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
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
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
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
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
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
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

/** Mounts the view id of pluginId on the harness h and waits for its composition declaration. */
async function mountView(h, id, pluginId = "fixture-plain", unload = false) {
  const { recordOrigin } = await import("../tab-reports.js");
  recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
  h.modules.authorizeSurface(id);
  await h.modules.mountSurface(h.slot, viewOf(id, pluginId, unload));
  await h.modules.waitSurfaceCompositionDeclared(id);
}

test("keep busy of a view protects its tab until an unload dispose, and keep modified follows the modified report", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const reports = await import("../tab-reports.js");
  const id = "view-keep";
  await mountView(h, id);
  await h.viewCall("tab.keep", { reason: "busy", on: true });
  await h.viewCall("tab.modified", true);
  assert.deepEqual(reports.tabKeeps(id), ["keep:modified", "keep:busy"]);
  await h.viewCall("tab.keep", { reason: "busy", on: false });
  assert.deepEqual(reports.tabKeeps(id), ["keep:modified"]);
  await h.viewCall("tab.keep", { reason: "busy", on: true });
  assert.deepEqual((await h.viewCall("tab.keep", { reason: "other", on: true })).error,
    { code: -32000, message: "unknown keep reason: other" });
  assert.deepEqual((await h.viewCall("tab.keep", { reason: "busy", on: 1 })).error,
    { code: -32000, message: "keep busy must be true or false" });
  await h.modules.disposeSurface(id, { mode: "unload" });
  assert.deepEqual(reports.tabKeeps(id), ["keep:modified"], "an unload dispose kept the busy protection or dropped the modified one");
  reports.reportModified(id, false);
  h.close();
});

test("an unload dispose keeps the tab reports of a view except its error, and a close forgets them", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const reports = await import("../tab-reports.js");
  for (const [id, mode] of [["view-unload-reports", "unload"], ["view-close-reports", undefined]]) {
    await mountView(h, id);
    await h.viewCall("tab.title", "Doc");
    await h.viewCall("tab.footer", "foot");
    await h.viewCall("tab.notify", { text: "done" });
    await h.viewCall("tab.error", "failed");
    await h.modules.disposeSurface(id, mode === undefined ? undefined : { mode });
  }
  assert.deepEqual([reports.tabLabel("view-unload-reports"), reports.tabFooter("view-unload-reports"),
    reports.tabNotice("view-unload-reports"), reports.tabError("view-unload-reports")], ["Doc", "foot", "done", null]);
  assert.deepEqual(reports.tabOrigin("view-unload-reports"), { directory: null });
  assert.deepEqual([reports.tabLabel("view-close-reports"), reports.tabFooter("view-close-reports"),
    reports.tabNotice("view-close-reports"), reports.tabError("view-close-reports")], [null, null, null, null]);
  await assert.rejects(h.modules.disposeSurface("view-unload-reports", { mode: "other" }), /unknown dispose mode: other/);
  h.close();
});

test("a title report of a declaring view writes the label cache, and a removed title removes it", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const id = "view-label-cache";
  await mountView(h, id, "fixture-unload", UNLOAD);
  await h.viewCall("tab.title", "Cached");
  assert.equal(store.label(id), "Cached");
  await h.viewCall("tab.title", null);
  assert.equal(store.label(id), null);
  await h.modules.disposeSurface(id);
  h.close();
});

test("a tab state write that a view sent before its dispose and that runs after it is not answered and stores nothing", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const id = "view-state-disposed";
  const reported = [];
  const originalDispatchEvent = globalThis.dispatchEvent;
  globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };
  t.after(() => { globalThis.dispatchEvent = originalDispatchEvent; });
  await mountView(h, id, "fixture-unload", UNLOAD);
  await h.viewCall("tab.state.write", { page: 1 });
  // The write of a declaring view waits for the tab state store, so it runs after the dispose that starts at once.
  const late = h.deliver("tab.state.write", { page: 9 });
  await h.modules.disposeSurface(id, { mode: "unload" });
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.calls.filter(({ name, payload }) => name === "viewReply" && payload.id === late), [],
    "a write that runs after the dispose was answered");
  assert.deepEqual(store.entry(id).state, { format: 2, value: { page: 1 } });
  assert.deepEqual(reported, [], "the write reached the tab state of the disposed view");
  h.close();
});

test("the composition of a view places nothing while a place that leaves the view out runs", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, placeSurfaces } = h.modules;
  const reports = await import("../tab-reports.js");
  const id = "view-place-a";
  reports.recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
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

test("a region query of a view that a running place leaves out waits for the place and asks no region of a released view", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, placeSurfaces } = h.modules;
  const { documentRegions } = await import("../document-regions.js");
  const reports = await import("../tab-reports.js");
  const id = "view-place-regions";
  reports.recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
  authorizeSurface(id);
  await mountSurface(h.slot, viewOf(id, "fixture-plain", false));
  await waitSurfaceCompositionDeclared(id);
  documentRegions.attached(id, "page");
  regionQueries.length = 0;
  let interaction;
  let reasons;
  await placeSurfaces(async () => {
    // The host closes the regions of the left-out view before its reply, so a query that starts now must not reach them.
    interaction = documentRegions.interaction(id);
    reasons = documentRegions.reasons(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(regionQueries, [], "a region query reached the host while the place that closes the region runs");
    return null;
  }, { retain: new Set() });
  assert.equal(await interaction, undefined);
  assert.deepEqual(await reasons, []);
  assert.deepEqual(regionQueries, [], "a region query reached the regions of a released view");
  await disposeSurface(id);
  h.close();
});

test("a region query of a view waits for a failed place that left the view out and then asks its regions", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, placeSurfaces } = h.modules;
  const { documentRegions } = await import("../document-regions.js");
  const reports = await import("../tab-reports.js");
  const id = "view-failed-place-regions";
  reports.recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
  authorizeSurface(id);
  await mountSurface(h.slot, viewOf(id, "fixture-plain", false));
  await waitSurfaceCompositionDeclared(id);
  documentRegions.attached(id, "page");
  regionQueries.length = 0;
  const failure = new Error("fixture placement rejected");
  let interaction;
  await assert.rejects(placeSurfaces(async () => {
    interaction = documentRegions.interaction(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(regionQueries, [], "a region query reached the host while the place that closes the region runs");
    throw failure;
  }, { retain: new Set() }), (error) => error === failure);
  // A failed place keeps the view and its regions, so the waiting query reads them.
  assert.deepEqual(await interaction, { page: "AAAA" });
  assert.deepEqual(regionQueries, [["documentInteractionState", id, "page"]]);
  await disposeSurface(id);
  h.close();
});

test("a sidecar send of a view waits for a failed place that leaves the view out, and a place that releases the view sends none", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { recordOrigin } = await import("../tab-reports.js");
  const id = "view-place-sidecar";
  recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
  h.modules.authorizeSurface(id);
  await h.modules.mountSurface(h.slot, { ...viewOf(id, "fixture-plain", false), sidecars: ["fixture-sidecar"] });
  await h.modules.waitSurfaceCompositionDeclared(id);
  const send = (op) => ({ id: "probe", sidecar: "fixture-sidecar", body: { op }, cids: [] });
  let during;
  await assert.rejects(h.modules.placeSurfaces(async () => {
    during = h.viewCall("runtime.sidecar.send", send("input"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(h.sent, [], "a sidecar send left while the place ran");
    throw new Error("host.place refused the layout");
  }, { retain: new Set() }), /host.place refused the layout/);
  assert.equal((await during).error, undefined, "the held send was refused after the failed place");
  assert.deepEqual(h.sent.map(({ op }) => op), ["input"]);
  // The place ends the sidecar sessions of the view that it leaves out, so a send held by that place is not sent after it.
  assert.equal(await h.modules.placeSurfaces(async () => {
    h.deliver("runtime.sidecar.send", send("end"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return "placed";
  }, { retain: new Set() }), "placed");
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.modules.mountedSurface(id), null);
  assert.deepEqual(h.sent.map(({ op }) => op), ["input"], "a send reached the sidecar after the place ended its sessions");
  h.close();
});

test("a view mount that a dispose ends before its authorization resolves null and declares no composition", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { recordOrigin } = await import("../tab-reports.js");
  const id = "view-dispose-before-authorization";
  recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
  const mounting = h.modules.mountSurface(h.slot, viewOf(id, "fixture-plain", false));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await h.modules.disposeSurface(id);
  assert.equal(h.slot.querySelector(`[data-surface="${id}"]`), null, "the surface was not removed before its authorization");
  const outcome = await Promise.race([mounting.then((value) => ({ value }), (error) => ({ error: error.message })),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 200))]);
  assert.deepEqual(outcome, { value: null }, "the mount that the dispose ended did not resolve");
  h.modules.authorizeSurface(id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.calls.filter(({ name }) => name === "compositionDeclare").length, 0, "a disposed mount declared its composition");
  h.close();
});

test("a view declares its composition only after the host authorizes its surface", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = h.modules;
  const reports = await import("../tab-reports.js");
  const id = "view-auth-a";
  reports.recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
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

test("a remounted view sends a higher composition revision in the same document", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = h.modules;
  const { recordOrigin } = await import("../tab-reports.js");
  const id = "view-remounted-revision";
  try {
    for (const generation of [1, 2]) {
      recordOrigin(id, null, "test fixture");
      seedSourceOrigins({ floor: generation, views: { [id]: generation } });
      authorizeSurface(id);
      await mountSurface(h.slot, viewOf(id, "fixture-plain", false));
      await waitSurfaceCompositionDeclared(id);
      const reply = await h.viewCall("composition.place", { regions: [], overlays: [] }, generation);
      assert.equal(reply.error, undefined, "the placement of the current view was refused");
      assert.equal(reply.generation, generation, "the placement reply belongs to another view generation");
      await disposeSurface(id);
    }
    const revisions = h.calls.filter(({ name }) => name === "compositionPlace").map(({ payload }) => payload.revision);
    assert.equal(revisions.length, 2, "both view generations must send their placement");
    assert.ok(Number.isInteger(revisions[0]) && revisions[0] > 0, "the first placement needs a positive revision");
    assert.ok(revisions[1] > revisions[0], `a remounted view reused a composition revision: ${revisions.join(", ")}`);
  } finally {
    await disposeSurface(id);
    h.close();
  }
});


test("a mount of a view waits for a pending dispose of the same tab and creates a new surface", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const id = "view-remount-pending-dispose";
  await mountView(h, id);
  const first = h.modules.mountedSurface(id);
  const disposing = h.modules.disposeSurface(id, { mode: "unload" });
  const remounting = h.modules.mountSurface(h.slot, viewOf(id, "fixture-plain", false));
  await disposing;
  h.modules.authorizeSurface(id);
  await remounting;
  const second = h.modules.mountedSurface(id);
  assert.notEqual(second, null, "the mount after the pending dispose left no mounted surface");
  assert.notEqual(second, first, "the mount reused the surface that the dispose released");
  assert.equal(second.disposed, false);
  assert.equal(second.closing.signal.aborted, false);
  assert.equal(h.slot.querySelectorAll(`[data-surface="${id}"]`).length, 1);
  await h.modules.disposeSurface(id);
  h.close();
});

test("each view mount reports its end to the mount listeners, with the error of a failed mount", { timeout: 5000 }, async (t) => {
  const refuse = new Set();
  const h = await harness(t, { refuse });
  const ended = [];
  const off = h.modules.onSurfaceMounted((id, error) => ended.push([id, error?.message ?? null]));
  await mountView(h, "view-mount-ok");
  const { recordOrigin } = await import("../tab-reports.js");
  const failed = "view-mount-refused";
  recordOrigin(failed, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [failed]: 1 } });
  refuse.add("compositionDeclare");
  h.modules.authorizeSurface(failed);
  await assert.rejects(h.modules.mountSurface(h.slot, viewOf(failed, "fixture-plain", false)), /the host refused compositionDeclare/);
  off();
  assert.deepEqual(ended, [["view-mount-ok", null], [failed, "the host refused compositionDeclare"]]);
  await h.modules.disposeSurface("view-mount-ok");
  await h.modules.disposeSurface(failed);
  h.close();
});

test("a later retained mount waits for the preceding placement release", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { mountSurface, authorizeSurface, disposeSurface, mountedSurface, placeSurfaces } = h.modules;
  const { recordOrigin } = await import("../tab-reports.js");
  const id = "view-retained-placement-order";
  recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
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


test("a replacement view registers its command once in its own source generation", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { recordOrigin } = await import("../tab-reports.js");
  const id = "view-restarted-command";
  const command = "fixture-plain.run";
  const { registry } = await import("../exposure.js");
  const registrations = [];
  const registered = registry.registered;
  t.mock.method(registry, "registered", (fields) => {
    registrations.push(fields);
    return registered(fields);
  });
  registry.declare("fixture-plain", { status: [], commands: [{ name: command, description: "Runs the fixture command.", params: { type: "object" }, result: { type: "null" } }], element: [] });
  recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
  h.modules.authorizeSurface(id);
  await h.modules.mountSurface(h.slot, { ...viewOf(id, "fixture-plain", false),
    declarations: { status: [], commands: [{ name: command, description: "Runs the fixture command.", params: { type: "object" }, result: { type: "null" } }], element: [] },
  });
  try {
    assert.deepEqual(await h.viewCall("runtime.command.register", { name: command }), expectedReply(h, 1, null));
    assert.match((await h.viewCall("runtime.command.register", { name: command })).error.message, /already registered/);
    assert.equal(endSourceOrigin("fixture-plain", id, 1), true);
    assert.equal(registerSourceOrigin("fixture-plain", id, 2), true);
    assert.deepEqual(await h.viewCall("runtime.command.register", { name: command }, 2),
      { id: 3, result: null, page: h.page, generation: 2 });
    assert.match((await h.viewCall("runtime.command.register", { name: command }, 2)).error.message, /already registered/);
    assert.equal(registrations.filter((fields) => fields.kind === "command" && fields.name === command).length, 2,
      "the replacement did not restore the command's public registration");
  } finally {
    await h.modules.disposeSurface(id);
    h.close();
  }
});


test("a failed view command registration returns its declaration error", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const { recordOrigin } = await import("../tab-reports.js");
  const id = "view-invalid-command-registration";
  recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
  h.modules.authorizeSurface(id);
  await h.modules.mountSurface(h.slot, viewOf(id, "fixture-plain", false));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await h.viewCall("runtime.command.register", { name: "fixture-plain.undeclared" });
      assert.match(reply.error?.message ?? "registration incorrectly succeeded", /not declared/);
    }
  } finally {
    await h.modules.disposeSurface(id);
    h.close();
  }
});

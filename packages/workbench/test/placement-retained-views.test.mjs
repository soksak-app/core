import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { logGate } from "../log-gate.js";
import { byteLength } from "@soksak/plugin-api/bounded-json.js";
import { pageIdentity } from "../page-identity.js";
import { drained } from "./support/drained.mjs";

// The host calls of each test are answered by its page-wire case (docs/spec/cases/page-wire/README.md). A test selects its case before
// it imports a module that imports host.js, because host.js reads the host when it is imported. The views are real mounts of the surface
// modules: a view that the test authorizes declares its composition to the host, and the placement sends the declared views.
const emptySurfaceDeclarations = { status: [], commands: [], element: [] };
const declarationBytes = byteLength(JSON.stringify(emptySurfaceDeclarations));

let wire = selectPageWire("placement-retained-views-retained");
const { registerPlugin } = await import("../registry.js");
const { seedSourceOrigins } = await import("../source-origins.js");
const { recordOrigin } = await import("../tab-reports.js");
const { setSurfaceTextSize } = await import("../text-size.js");
const { createMemorySaver } = await import("../memory-saver.js");
const { memoryPlacement } = await import("../memory-placement.js");
const { flushEvents } = await import("../page-log.js");
const modules = await import("../surface-modules.js");

setSurfaceTextSize(() => 1);
registerPlugin({ id: "placement-probe", surface: () => null });
registerPlugin({ id: "held-start-probe", surface: () => null });
registerPlugin({ id: "retained-race-plugin", surface: () => null });

const descriptor = (id, pluginId = "placement-probe") => ({ surfaceId: id, pluginId, declarations: emptySurfaceDeclarations, sidecars: [],
  composition: { kind: "view", page: "ui/page.html" }, params: null, diagnostics: null, unload: false });
const names = () => wire.calls.map(({ name }) => name);
const syncs = () => wire.calls.filter(({ name }) => name === "syncSurfaces").map(({ payload }) => payload);
const syncEvents = () => wire.calls.filter(({ name, payload }) => name === "log" && payload.action === "batch")
  .flatMap(({ payload }) => payload.events).filter(({ event }) => event === "workbench.trace.surface.sync");

/** A page document with a plane, and the origins that the mounts of ids need. */
function pageOf(ids) {
  const dom = new JSDOM('<div id="plane"></div>', { url: "https://example.test/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  seedSourceOrigins({ floor: 1, views: Object.fromEntries(ids.map((id) => [id, 1])) });
  for (const id of ids) recordOrigin(id, null, "test fixture");
  return dom;
}

/** Mounts the view id in a slot of the plane, as the plane draw does, and waits for its composition declaration. */
async function mountDeclared(id, pluginId = "placement-probe") {
  const slot = document.createElement("div");
  document.querySelector("#plane").append(slot);
  modules.authorizeSurface(id);
  modules.mountSurface(slot, descriptor(id, pluginId));
  await modules.waitSurfaceCompositionDeclared(id);
}

test("a host placement retains mounted dormant views and excludes cold dormant views", async () => {
  const dom = pageOf(["visible-view", "retained-view", "cold-view", "background-view"]);
  const priorPolicy = logGate.classes();
  try {
    logGate.set({ ...priorPolicy, frame: "trace" });
    const host = await import("../host.js?retained-view-placement");
    const { placeCompositorRecord } = await import("../compositor.js?retained-view-placement");
    const retainedMounts = await import("../retained-surface-mounts.js?retained-view-placement");
    await host.surfaces.theme({ scheme: "dark", tokens: {} });
    // The views that the plane drew and the host authorized before the placement.
    await mountDeclared("visible-view");
    await mountDeclared("retained-view");
    const attemptOf = (id) => modules.mountedSurface(id).mountRegistration.attempt;
    assert.deepEqual([attemptOf("visible-view"), attemptOf("retained-view")], [1, 2]);
    const view = (id, x) => ({ id, plugin: "placement-probe", dim: false, visible: id === "visible-view", applied: { x, y: 0, w: 20, h: 20 },
      surface: descriptor(id), start: { origin: { directory: null }, declarations: emptySurfaceDeclarations } });
    const record = { surfaces: [view("visible-view", 0)], settled: true, drawn: true, titlebar: 40 };
    const requested = [record.surfaces[0], view("retained-view", 20),
      { ...view("cold-view", 40), retainedTextSize: () => 1.875 }, view("background-view", 60)];
    let held = null;
    const beforePlacement = wire.calls.length;
    const answer = await placeCompositorRecord(record, requested,
      (request) => host.surfaces.place({ ...record, surfaces: request.surfaces }),
      ["placement-probe"],
      {
        mountedSurface: modules.mountedSurface,
        background: (surface) => surface.id === "background-view",
        authorize: modules.authorizeSurface,
        prepare: retainedMounts.prepareRetainedSurface,
        held: (ids) => { held = ids; },
      });

    assert.deepEqual(syncs()[0].surfaces.map(({ id }) => id),
      ["visible-view", "retained-view", "cold-view"], "the host request did not preserve retained views or prepare the cold loaded view");
    assert.deepEqual(names().slice(beforePlacement).filter((name) => name !== "log"), ["compositionDeclare", "syncSurfaces", "presentSurfaces"],
      "the cold view did not declare its composition before the host sync, or the host sync was sent twice");
    assert.equal(attemptOf("cold-view"), 3);
    assert.ok(document.querySelector('[data-retained-surface-mounts] [data-surface="cold-view"]')?.closest("[hidden]"),
      "a retained view was not mounted in the hidden slot");
    await flushEvents();
    assert.deepEqual(syncEvents()[0].fields, {
      page: pageIdentity, requestId: 1, views: [
        { surface: "visible-view", attempt: 1 },
        { surface: "retained-view", attempt: 2 },
        { surface: "cold-view", attempt: 3 },
      ], outcome: "accepted", declarationInlineBytes: 3 * declarationBytes,
      declarationTableBytes: declarationBytes + 2,
    }, "the completed sync record did not identify the exact view set and mount attempts");
    assert.equal(Object.hasOwn(syncs()[0].surfaces[2], "retainedTextSize"), false,
      "workbench-only retained text scale metadata crossed the host placement boundary");
    assert.deepEqual(answer.placements.map(({ id }) => id), ["visible-view"], "the host's dormant placement entered the compositor result");
    assert.deepEqual(answer.deferred, [], "a cold dormant view was reported as a host deferral");
    assert.deepEqual(held, ["visible-view", "retained-view", "cold-view"],
      "the surfaces that the host holds for the keyboard left out the retained views of the complete request");

    const retained = view("retained-view", 20);
    const saver = createMemorySaver({
      now: () => 0,
      enabled: () => true,
      delay: () => 720,
      declaration: () => "unload",
      keeps: () => [],
      kept: () => false,
      setKept: () => {},
      regions: async () => [],
      interaction: async () => {},
      restore: () => {},
      commit: async () => {},
      showLabel: () => {},
      changed: () => {},
      failed: () => {},
    });
    saver.observe(new Set(["retained-view"]), [{ id: "retained-view", plugin: "placement-probe", kind: "tab" }]);
    const undrawn = { surfaces: [], drawn: false, settled: false, titlebar: 40 };
    const classified = await memoryPlacement(undrawn, [retained], {
      ready: Promise.resolve(), saver, observe: () => {}, start: (entries) => entries,
    });
    const beforeDraw = await placeCompositorRecord(undrawn, classified.surfaces,
      (request) => host.surfaces.place({ ...undrawn, surfaces: request.surfaces }),
      ["placement-probe"], {
        activeIds: new Set(["retained-view"]),
        mountedSurface: modules.mountedSurface,
        authorize: modules.authorizeSurface,
      });
    const undrawnSync = syncs().at(-1);
    assert.deepEqual(undrawnSync?.surfaces.map(({ id }) => id), ["retained-view"],
      "an already-mounted loaded view was omitted from the complete undrawn host request");
    assert.equal(undrawnSync.surfaces[0].visible, false,
      "the retained view did not stay hidden while it had no compositor slot");
    assert.deepEqual(beforeDraw.placements, [], "the retained-only view entered an empty compositor record");

    // The title bar differs, so the drawn commit sends a second request: the settled value alone does not.
    const drawn = { surfaces: [retained], drawn: true, settled: true, titlebar: 41 };
    const afterDraw = await memoryPlacement(drawn, [retained], {
      ready: Promise.resolve(), saver, observe: () => {}, start: (entries) => entries,
    });
    await placeCompositorRecord(drawn, afterDraw.surfaces,
      (request) => host.surfaces.place({ ...drawn, surfaces: request.surfaces }),
      ["placement-probe"], {
        activeIds: new Set(["retained-view"]),
        mountedSurface: modules.mountedSurface,
        authorize: modules.authorizeSurface,
      });
    const sequence = syncs().slice(-2).map((request) => request.surfaces.map(({ id }) => id));
    assert.deepEqual(sequence, [["retained-view"], ["retained-view"]],
      "the retained view was removed and reintroduced across the undrawn and drawn requests");
    await flushEvents();
    assert.deepEqual(syncEvents().slice(-2).map(({ fields }) => fields.views), [
      [{ surface: "retained-view", attempt: 2 }],
      [{ surface: "retained-view", attempt: 2 }],
    ], "the retained host requests did not preserve the same mounted attempt");

    retainedMounts.releaseRetainedSurfaceSlots(record, new Set(["visible-view", "retained-view", "cold-view", "background-view"]));
    assert.ok(document.querySelector("[data-retained-surface-mounts]"), "the loaded dormant view lost its retained mount slot");
    retainedMounts.releaseRetainedSurfaceSlots(record, new Set(["cold-view"]), ["cold-view"]);
    assert.equal(document.querySelector("[data-retained-surface-mounts]"), null, "an unloaded dormant view kept its hidden mount slot");
    retainedMounts.releaseRetainedSurfaceSlots(record, new Set());
    assert.equal(document.querySelector("[data-retained-surface-mounts]"), null, "released hidden mount slots remained in the document");
  } finally {
    logGate.set(priorPolicy);
    for (const id of ["visible-view", "retained-view", "cold-view"]) await modules.disposeSurface(id);
    dom.window.close();
  }
  wire.finish();
});

test("surface sync traces its result only while the frame log gate is open", { timeout: 5000 }, async () => {
  wire = selectPageWire("placement-retained-views-sync-trace");
  const dom = pageOf(["sync-trace-view"]);
  registerPlugin({ id: "sync-trace-probe", surface: () => null });
  const view = { id: "sync-trace-view", plugin: "sync-trace-probe", dim: false, visible: true,
    applied: { x: 0, y: 0, w: 20, h: 20 },
    surface: descriptor("sync-trace-view", "sync-trace-probe"),
    start: { origin: { directory: null }, declarations: emptySurfaceDeclarations } };
  const priorPolicy = logGate.classes();
  try {
    const host = await import("../host.js?surface-sync-trace-result");
    await host.surfaces.theme({ scheme: "dark", tokens: {} });
    await mountDeclared(view.id, "sync-trace-probe");
    const attempt = modules.mountedSurface(view.id).mountRegistration.attempt;
    // The record of the real mount counts the reads of its registration and answers each with the registration it holds.
    const mounted = modules.mountedSurface(view.id);
    const registration = mounted.mountRegistration;
    let mountTraceLookups = 0;
    Object.defineProperty(mounted, "mountRegistration", { configurable: true,
      get: () => { mountTraceLookups += 1; return registration; } });
    logGate.set({ ...priorPolicy, frame: "off" });
    const record = { surfaces: [view], settled: true, drawn: true, titlebar: 40 };
    await assert.rejects(host.surfaces.place(record), /composition missing in current page/);
    await flushEvents();
    assert.deepEqual(syncEvents(), [], "a disabled trace wrote a surface sync record");
    assert.equal(mountTraceLookups, 0, "a disabled trace read mount metadata to build fields");

    logGate.set({ ...priorPolicy, frame: "trace" });
    await assert.rejects(host.surfaces.place({ ...record, surfaces: [{ ...view, applied: { ...view.applied, x: 1 } }] }),
      /composition missing in current page/);
    await flushEvents();
    assert.equal(syncEvents().length, 1, "an enabled sync did not record its result");
    assert.equal(mountTraceLookups, 1, "an enabled sync did not read its mount attempt exactly once");

    logGate.set({ ...priorPolicy, frame: "off" });
    const openingPlacement = host.surfaces.place({ ...record,
      surfaces: [{ ...view, applied: { ...view.applied, x: 2 } }] });
    await drained();
    assert.equal(mountTraceLookups, 1, "pending sync read mount metadata before its completion policy was known");
    logGate.set({ ...priorPolicy, frame: "trace" });
    wire.release();
    await assert.rejects(openingPlacement, /composition missing in current page/);
    assert.equal(mountTraceLookups, 2, "a gate opened before completion did not read its view metadata");
    await flushEvents();
    assert.equal(syncEvents().length, 2, "a gate opened while sync was pending did not record its completed request");

    const closingPlacement = host.surfaces.place({ ...record,
      surfaces: [{ ...view, applied: { ...view.applied, x: 3 } }] });
    await drained();
    assert.equal(mountTraceLookups, 2, "pending sync read mount metadata before its completion policy was known");
    logGate.set({ ...priorPolicy, frame: "off" });
    wire.release();
    await assert.rejects(closingPlacement, /composition missing in current page/);
    assert.equal(mountTraceLookups, 2, "a gate closed before completion still read view metadata");
    await flushEvents();
    assert.equal(syncEvents().length, 2, "a gate closed while sync was pending still recorded its completed request");
    // The records of the two requests whose gate was open at their completion are the only ones in the log: a request that completed
    // while the gate was closed left no record, and the request ids count the recorded requests.
    assert.deepEqual(syncEvents().map(({ fields }) => fields), [1, 2].map((requestId) => ({
      page: pageIdentity, requestId, views: [{ surface: view.id, attempt }], outcome: "rejected",
      declarationInlineBytes: declarationBytes, declarationTableBytes: declarationBytes + 2,
    })), "a rejected native sync was not recorded with its exact request view and mount attempt, or a closed gate recorded a request");
  } finally {
    logGate.set(priorPolicy);
    await modules.disposeSurface(view.id);
    dom.window.close();
  }
  wire.finish();
});

test("host placement sends start values until the host holds them and again after a refusal", { timeout: 5000 }, async () => {
  wire = selectPageWire("placement-retained-views-held-start");
  const dom = pageOf(["held-start-view"]);
  const view = { id: "held-start-view", plugin: "held-start-probe", dim: false, visible: true,
    applied: { x: 0, y: 0, w: 20, h: 20 },
    surface: descriptor("held-start-view", "held-start-probe"),
    start: { params: null, origin: { directory: null }, declarations: emptySurfaceDeclarations } };
  const at = (x, params = null) => ({ surfaces: [{ ...view, applied: { ...view.applied, x },
    start: { ...view.start, params } }], settled: true, drawn: true, titlebar: 40 });
  try {
    const host = await import("../host.js?held-start-values");
    await host.surfaces.theme({ scheme: "dark", tokens: {} });
    await mountDeclared("held-start-view", "held-start-probe");
    const startOfLast = () => syncs().at(-1).surfaces[0].start;
    await host.surfaces.place(at(0));
    assert.equal(startOfLast()?.declarations, 0, "the first request did not carry the start values");
    await host.surfaces.place(at(1));
    assert.equal(syncs().length, 2, "a changed placement sent no request");
    assert.equal(startOfLast(), undefined, "a request carried start values that the host holds");
    await host.surfaces.place(at(1));
    assert.equal(syncs().length, 2, "a request with the same layout and start values was sent");
    await host.surfaces.place(at(1, { path: "a.md" }));
    assert.equal(syncs().length, 3, "a request with changed start values was not sent");
    assert.deepEqual(startOfLast()?.params, { path: "a.md" }, "changed start values were not carried");
    await assert.rejects(host.surfaces.place(at(2, { path: "a.md" })), /surface refused/);
    assert.equal(startOfLast(), undefined, "the fixture request before the refusal carried start values");
    await host.surfaces.place(at(3, { path: "a.md" }));
    assert.deepEqual(startOfLast()?.params, { path: "a.md" }, "the request after a refusal did not carry the start values");
  } finally {
    await modules.disposeSurface("held-start-view");
    dom.window.close();
  }
  wire.finish();
});

test("host placement preserves call order across the lazy view-module import", { timeout: 5000 }, async () => {
  wire = selectPageWire("placement-retained-views-lazy-import");
  const id = "retained-race-view";
  const dom = pageOf([id]);
  const surface = { id, plugin: "retained-race-plugin", dim: false, visible: true,
    applied: { x: 0, y: 0, w: 20, h: 20 },
    surface: descriptor(id, "retained-race-plugin"),
    start: { origin: { directory: null }, declarations: emptySurfaceDeclarations } };
  const emptyRecord = { surfaces: [], settled: true, drawn: true, titlebar: 40 };
  const viewRecord = { surfaces: [surface], settled: true, drawn: true, titlebar: 40 };

  try {
    const actualHost = await import("../host.js?retained-race");
    const { placeCompositorRecord } = await import("../compositor.js?retained-race");
    const host = actualHost.surfaces;
    await host.theme({ scheme: "dark", tokens: {} });
    await mountDeclared(id, "retained-race-plugin");
    const staleLayout = placeCompositorRecord(viewRecord, [surface], (request) => host.place(request),
      ["retained-race-plugin"], { mountedSurface: modules.mountedSurface, authorize: modules.authorizeSurface })
      .then(() => null, (error) => error);

    // The first call needs the lazy surface-module import; the newer empty layout must not overtake it while
    // that import is pending. The current layout then retires the view after its earlier placement is accepted.
    await host.place(emptyRecord);
    const staleError = await staleLayout;
    assert.equal(staleError, null, "the earlier view placement failed before the current layout retired it");
    assert.deepEqual(syncs().map((request) => request.surfaces.map(({ id: surfaceId }) => surfaceId)), [[id], []],
      "native sync calls did not preserve host placement invocation order");
  } finally {
    await modules.disposeSurface(id);
    dom.window.close();
  }
  wire.finish();
});

test("an active view that is not in an undrawn record waits for its drawn commit", async () => {
  wire = selectPageWire("placement-retained-views-active-view");
  const dom = pageOf(["active-view"]);
  try {
    const host = await import("../host.js?active-view-placement");
    const { placeCompositorRecord } = await import("../compositor.js?active-view-placement");
    await host.surfaces.theme({ scheme: "dark", tokens: {} });
    const view = { id: "active-view", plugin: "placement-probe", dim: false, visible: true, applied: { x: 0, y: 0, w: 20, h: 20 },
      surface: descriptor("active-view"), start: { origin: { directory: null }, declarations: emptySurfaceDeclarations } };
    const activeIds = new Set([view.id]);
    const policy = { activeIds, mountedSurface: modules.mountedSurface, authorize: modules.authorizeSurface };
    const prepared = await placeCompositorRecord({ surfaces: [], settled: true, drawn: false, titlebar: 40 }, [view],
      (request) => host.surfaces.place(request), ["placement-probe"], policy);
    assert.deepEqual(prepared, { placements: [], deferred: [] }, "an upcoming active view was treated as a dormant surface");
    assert.deepEqual(syncs().find(Boolean)?.surfaces, [],
      "the undrawn record sent an active tab before its plane slot existed");

    // The plane draws the slot of the tab, which mounts the view, and the host authorizes it.
    await mountDeclared(view.id);
    const callsBefore = syncs().length;
    const drawn = await placeCompositorRecord({ surfaces: [view], settled: true, drawn: true, titlebar: 40 }, [view],
      (request) => host.surfaces.place(request), ["placement-probe"], policy);
    assert.deepEqual(drawn.placements.map(({ id }) => id), [view.id], "the active view did not enter the drawn placement");
    assert.deepEqual(syncs()[callsBefore].surfaces.map(({ id }) => id), [view.id]);
  } finally {
    await modules.disposeSurface("active-view");
    dom.window.close();
  }
  wire.finish();
});

test("an unloaded cold view is classified before a drawn host placement", async () => {
  wire = selectPageWire("placement-retained-views-cold-unload");
  const dom = pageOf(["cold-unload-view"]);
  const memory = createMemorySaver({
    now: () => 0, enabled: () => true, delay: () => 1,
    declaration: () => "unload", keeps: () => [], kept: () => false, setKept: () => {},
    regions: async () => [], interaction: async () => {}, restore: () => {},
    commit: () => Promise.resolve(), showLabel: () => {}, changed: () => {}, failed: (text) => { throw new Error(text); },
    stateChanged: () => {},
  });
  try {
    const host = await import("../host.js?memory-classification-placement");
    const { placeCompositorRecord } = await import("../compositor.js?memory-classification-placement");
    const retainedMounts = await import("../retained-surface-mounts.js?memory-classification-placement");
    await host.surfaces.theme({ scheme: "dark", tokens: {} });
    const cold = { id: "cold-unload-view", plugin: "placement-probe", dim: false, visible: false,
      applied: { x: 0, y: 0, w: 0, h: 0 },
      surface: descriptor("cold-unload-view"), start: { origin: { directory: null }, declarations: emptySurfaceDeclarations } };
    const candidates = [cold];
    let initialized = false;
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    // The order of the drawn placement: observed is listed when the placement observes its record, which the placement does after ready.
    let order = null;
    const observe = (_record, tabs) => {
      if (order) order.push("observed");
      if (initialized) memory.observe(new Set(), tabs.map(({ id, plugin }) => ({ id, plugin, kind: "tab" })));
    };
    const policy = { mountedSurface: modules.mountedSurface, authorize: modules.authorizeSurface, prepare: retainedMounts.prepareRetainedSurface };
    const undrawn = { surfaces: [], settled: true, drawn: false, titlebar: 40 };
    const beforeDraw = await memoryPlacement(undrawn, candidates, { ready, saver: memory, observe, start: (entries) => entries });
    const prepared = await placeCompositorRecord(undrawn, beforeDraw.surfaces,
      (request) => host.surfaces.place(request), ["placement-probe"], policy);
    assert.deepEqual(prepared, { placements: [], deferred: [] }, "an undrawn preparation waited for startup classification");
    assert.deepEqual(syncs().find(Boolean)?.surfaces, [],
      "an undrawn preparation sent a cold hidden view");
    assert.equal(modules.mountedSurface(cold.id), null, "an undrawn preparation mounted a cold hidden view");

    // The order shows that the drawn placement observed its record and ended after the startup classification, which is marked right
    // before ready resolves. The placement is started before the mark, and one microtask passes before the mark: a placement that
    // did not wait for ready has observed its record by then, so observed is listed before ready.
    order = [];
    const drawn = { surfaces: [], settled: true, drawn: true, titlebar: 40 };
    const classifiedPlacement = memoryPlacement(drawn, candidates, { ready, saver: memory, observe, start: (entries) => entries }).then((value) => {
      order.push("finished");
      return value;
    });
    memory.observe(new Set(), [{ id: cold.id, plugin: cold.plugin, kind: "tab" }]);
    order.push("classified");
    memory.classify();
    await Promise.resolve();
    order.push("ready");
    initialized = true;
    resolveReady();
    const classified = await classifiedPlacement;
    assert.deepEqual(order, ["classified", "ready", "observed", "finished"], "drawn placement did not wait for startup memory classification");
    const answer = await placeCompositorRecord(drawn, classified.surfaces,
      (request) => host.surfaces.place(request), ["placement-probe"], policy);

    assert.deepEqual(answer.placements, [], "an unload-declared hidden tab entered the drawn compositor record");
    assert.deepEqual(syncs().find(Boolean)?.surfaces, [],
      "startup placed a cold hidden view after the memory saver classified it as unloaded");
    assert.equal(modules.mountedSurface(cold.id), null, "startup mounted a hidden tab that should start unloaded");
    assert.equal(memory.state(cold.id), "unloaded", "the enabled memory saver did not classify the cold tab as unloaded");

    const startupFailure = new Error("tab state initialization failed");
    let rejectReady;
    const failedReady = new Promise((_resolve, reject) => { rejectReady = reject; });
    let observedAfterFailure = false;
    const waiting = [1, 2].map(() => memoryPlacement(drawn, candidates, {
      ready: failedReady, saver: memory, start: (entries) => entries,
      observe: () => { observedAfterFailure = true; },
    }));
    rejectReady(startupFailure);
    const rejected = await Promise.allSettled(waiting);
    assert.deepEqual(rejected.map(({ status, reason }) => [status, reason]),
      [["rejected", startupFailure], ["rejected", startupFailure]], "startup failure left a placement waiter pending");
    assert.equal(observedAfterFailure, false, "placement observed tabs after startup classification failed");
  } finally {
    dom.window.close();
  }
  wire.finish();
});

test("a disabled memory saver mounts a cold hidden view at startup", async () => {
  wire = selectPageWire("placement-retained-views-cold-loaded");
  const dom = pageOf(["cold-loaded-view"]);
  const memory = createMemorySaver({
    now: () => 0, enabled: () => false, delay: () => 1,
    declaration: () => "unload", keeps: () => [], kept: () => false, setKept: () => {},
    regions: async () => [], interaction: async () => {}, restore: () => {},
    commit: () => Promise.resolve(), showLabel: () => {}, changed: () => {}, failed: (text) => { throw new Error(text); },
    stateChanged: () => {},
  });
  try {
    const host = await import("../host.js?memory-saver-disabled-placement");
    const { placeCompositorRecord } = await import("../compositor.js?memory-saver-disabled-placement");
    const retainedMounts = await import("../retained-surface-mounts.js?memory-saver-disabled-placement");
    await host.surfaces.theme({ scheme: "dark", tokens: {} });
    const cold = { id: "cold-loaded-view", plugin: "placement-probe", dim: false, visible: false,
      applied: { x: 0, y: 0, w: 0, h: 0 },
      surface: descriptor("cold-loaded-view"), start: { origin: { directory: null }, declarations: emptySurfaceDeclarations } };
    const candidates = [cold];
    memory.observe(new Set(), [{ id: cold.id, plugin: cold.plugin, kind: "tab" }]);
    memory.classify();
    const classified = await memoryPlacement({ surfaces: [], drawn: true }, candidates, {
      ready: Promise.resolve(), saver: memory, start: (entries) => entries,
      observe: (_record, tabs) => memory.observe(new Set(), tabs.map(({ id, plugin }) => ({ id, plugin, kind: "tab" }))),
    });
    const answer = await placeCompositorRecord({ surfaces: [], drawn: true, settled: true, titlebar: 40 },
      classified.surfaces, (request) => host.surfaces.place(request), ["placement-probe"], {
        mountedSurface: modules.mountedSurface,
        authorize: modules.authorizeSurface,
        prepare: retainedMounts.prepareRetainedSurface,
      });

    assert.equal(memory.state(cold.id), "loaded", "a disabled memory saver unloaded a hidden tab");
    assert.deepEqual(syncs().find(Boolean)?.surfaces.map(({ id }) => id), [cold.id],
      "a disabled memory saver did not mount its hidden view at startup");
    assert.deepEqual(answer.placements, [], "a hidden cold view entered the empty compositor record");
    retainedMounts.releaseRetainedSurfaceSlots({ surfaces: [] }, new Set([cold.id]));
  } finally {
    await modules.disposeSurface("cold-loaded-view");
    dom.window.close();
  }
  wire.finish();
});

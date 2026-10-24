import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { clockAnswer } from "./support/records.mjs";
import { createMemorySaver } from "../memory-saver.js";
import { memoryPlacement } from "../memory-placement.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

test("a host placement retains mounted dormant views and excludes cold dormant views", async (t) => {
  const dom = new JSDOM('<div id="plane"></div>', { url: "https://example.test/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const mounted = new Set(["visible-view", "retained-view"]);
  const waited = [];
  const calls = [];
  const mountOrder = [];
  const authorize = (id) => { mountOrder.push(`authorize:${id}`); };
  t.mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: (id) => mounted.has(id) ? { surfaceId: id, disposed: false } : null,
    authorizeSurface: authorize,
    mountSurface: async (slot, surface) => {
      mountOrder.push(`mount:${surface.surfaceId}`);
      assert.ok(slot.closest("[hidden]"), "a retained view was not mounted in the hidden slot");
      mounted.add(surface.surfaceId);
    },
    waitSurfaceCompositionDeclared: async (id) => {
      waited.push(id);
      mountOrder.push(`wait:${id}`);
      if (!mounted.has(id)) throw new Error(`surface ${id} is not mounted`);
    },
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      calls.push({ name, request });
      if (name === "log") return clockAnswer(name, request);
      if (name === "setTheme") return null;
      if (name === "syncSurfaces") {
        mountOrder.push("syncSurfaces");
        return {
        ticket: 1,
        placements: request.surfaces.map(({ id, x, y, w, h }) => ({ id, visible: true, x, y, w, h })),
        chrome: { controls: { x: 0, y: 0, w: 0, h: 0 }, row: request.titlebar },
        };
      }
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });

  try {
    const host = await import("../host.js?retained-view-placement");
    const { placeCompositorRecord } = await import("../compositor.js?retained-view-placement");
    const retainedMounts = await import("../retained-surface-mounts.js?retained-view-placement");
    await host.surfaces.theme({ scheme: "dark", tokens: {} });
    calls.length = 0;
  const view = (id, x) => ({ id, plugin: "placement-probe", dim: false, visible: id === "visible-view", applied: { x, y: 0, w: 20, h: 20 },
    surface: { surfaceId: id, pluginId: "placement-probe", composition: { kind: "view", page: "ui/page.html" } },
      start: { origin: { directory: null } } });
    const record = { surfaces: [view("visible-view", 0)], settled: true, drawn: true, titlebar: 40 };
    const requested = [record.surfaces[0], view("retained-view", 20),
      { ...view("cold-view", 40), retainedTextSize: () => 1.875 }, view("background-view", 60)];
    const answer = await placeCompositorRecord(record, requested,
      (request) => host.surfaces.place({ ...record, surfaces: request.surfaces }),
      ["placement-probe"],
      {
        mountedSurface: (id) => mounted.has(id) ? { surfaceId: id, disposed: false } : null,
        background: (surface) => surface.id === "background-view",
        authorize,
        prepare: retainedMounts.prepareRetainedSurface,
      });

    assert.deepEqual(calls.find(({ name }) => name === "syncSurfaces")?.request.surfaces.map(({ id }) => id),
      ["visible-view", "retained-view", "cold-view"], "the host request did not preserve retained views or prepare the cold loaded view");
    assert.equal(Object.hasOwn(calls.find(({ name }) => name === "syncSurfaces").request.surfaces[2], "retainedTextSize"), false,
      "workbench-only retained text scale metadata crossed the host placement boundary");
    assert.deepEqual(waited, ["visible-view", "retained-view", "cold-view"], "the host composition barrier did not wait for every requested view");
    assert.deepEqual(mountOrder.slice(0, 3), ["authorize:visible-view", "authorize:cold-view", "mount:cold-view"],
      "current and cold views did not start their listener setup before host sync");
    assert.deepEqual(mountOrder.slice(-4), ["wait:visible-view", "wait:retained-view", "wait:cold-view", "syncSurfaces"],
      "the host sync began before every requested view declared composition");
    assert.deepEqual(answer.placements.map(({ id }) => id), ["visible-view"], "the host's dormant placement entered the compositor result");
    assert.deepEqual(answer.deferred, [], "a cold dormant view was reported as a host deferral");
    retainedMounts.releaseRetainedSurfaceSlots(record, new Set(["visible-view", "retained-view", "cold-view", "background-view"]));
    assert.ok(document.querySelector("[data-retained-surface-mounts]"), "the loaded dormant view lost its retained mount slot");
    retainedMounts.releaseRetainedSurfaceSlots(record, new Set(["cold-view"]), ["cold-view"]);
    assert.equal(document.querySelector("[data-retained-surface-mounts]"), null, "an unloaded dormant view kept its hidden mount slot");
    retainedMounts.releaseRetainedSurfaceSlots(record, new Set());
    assert.equal(document.querySelector("[data-retained-surface-mounts]"), null, "released hidden mount slots remained in the document");
  } finally {
    dom.window.close();
  }
});

test("host placement preserves call order across the lazy view-module import", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM('<div id="plane"><div id="slot"></div></div>', { url: "https://example.test/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const id = "retained-race-view";
  const declarations = new Set();
  const syncs = [];
  let mounted = { surfaceId: id, disposed: false };
  t.mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: (surfaceId) => surfaceId === id ? mounted : null,
    waitSurfaceCompositionDeclared: async (surfaceId) => {
      assert.equal(surfaceId, id);
    },
  } });
  t.mock.module("@soksak/runtime", { namedExports: { windows: {}, host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      if (name === "log") return clockAnswer(name, request);
      if (name === "compositionDeclare") {
        declarations.add(request.surface);
        return null;
      }
      if (name === "setTheme") return null;
      if (name === "syncSurfaces") {
        const ids = request.surfaces.map(({ id: surfaceId }) => surfaceId);
        syncs.push(ids);
        for (const { id: surfaceId, composition } of request.surfaces) {
          if (composition.kind === "view" && !declarations.has(surfaceId)) {
            throw new Error(`surface ${surfaceId} has no composition declaration in the current page`);
          }
        }
        for (const surfaceId of declarations) if (!ids.includes(surfaceId)) declarations.delete(surfaceId);
        if (!ids.includes(id)) mounted = { surfaceId: id, disposed: true };
        return { ticket: syncs.length, placements: request.surfaces.map(({ id: surfaceId, x, y, w, h }) =>
          ({ id: surfaceId, visible: true, x, y, w, h })),
        chrome: { controls: { x: 0, y: 0, w: 0, h: 0 }, row: request.titlebar } };
      }
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const actualHost = await import("../host.js?retained-race");
  const { placeCompositorRecord } = await import("../compositor.js?retained-race");
  declarations.add(id);
  const surface = { id, plugin: "retained-race-plugin", dim: false, visible: true,
    applied: { x: 0, y: 0, w: 20, h: 20 },
    surface: { surfaceId: id, pluginId: "retained-race-plugin", composition: { kind: "view", page: "ui/page.html" } },
    start: { origin: { directory: null } } };
  const emptyRecord = { surfaces: [], settled: true, drawn: true, titlebar: 40 };
  const viewRecord = { surfaces: [surface], settled: true, drawn: true, titlebar: 40 };

  try {
    const host = actualHost.surfaces;
    await host.theme({ scheme: "dark", tokens: {} });
    const staleLayout = placeCompositorRecord(viewRecord, [surface], (request) => host.place(request),
      ["retained-race-plugin"], { mountedSurface: () => mounted, authorize: () => {} })
      .then(() => null, (error) => error);

    // The first call needs the lazy surface-module import; the newer empty layout must not overtake it while
    // that import is pending. The current layout then retires the view after its earlier placement is accepted.
    await host.place(emptyRecord);
    const staleError = await staleLayout;
    assert.equal(staleError, null, "the earlier view placement failed before the current layout retired it");
    assert.deepEqual(syncs, [[id], []], "native sync calls did not preserve host placement invocation order");
    assert.equal(declarations.has(id), false, "the current empty layout did not retire the old view declaration");
  } finally {
    dom.window.close();
  }
});

test("an active view that is not in an undrawn record waits for its drawn commit", async (t) => {
  const dom = new JSDOM('<div id="plane"></div>', { url: "https://example.test/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const mounted = new Set();
  const calls = [];
  t.mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: (id) => mounted.has(id) ? { surfaceId: id, disposed: false } : null,
    waitSurfaceCompositionDeclared: async (id) => {
      if (!mounted.has(id)) throw new Error(`surface ${id} is not mounted`);
    },
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      calls.push({ name, request });
      if (name === "log") return clockAnswer(name, request);
      if (name === "setTheme") return null;
      if (name === "syncSurfaces") return { ticket: 1,
        placements: request.surfaces.map(({ id, x, y, w, h }) => ({ id, visible: true, x, y, w, h })),
        chrome: { controls: { x: 0, y: 0, w: 0, h: 0 }, row: request.titlebar } };
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  try {
    const host = await import("../host.js?active-view-placement");
    const { placeCompositorRecord } = await import("../compositor.js?active-view-placement");
    await host.surfaces.theme({ scheme: "dark", tokens: {} });
    calls.length = 0;
    const view = { id: "active-view", plugin: "placement-probe", dim: false, visible: true, applied: { x: 0, y: 0, w: 20, h: 20 },
      surface: { surfaceId: "active-view", pluginId: "placement-probe", composition: { kind: "view", page: "ui/page.html" } },
      start: { origin: { directory: null } } };
    const activeIds = new Set([view.id]);
    const policy = {
      activeIds,
      mountedSurface: (id) => mounted.has(id) ? { surfaceId: id, disposed: false } : null,
      authorize: (id) => { assert.equal(id, view.id); mounted.add(id); },
    };
    const prepared = await placeCompositorRecord({ surfaces: [], settled: true, drawn: false, titlebar: 40 }, [view],
      (request) => host.surfaces.place(request), ["placement-probe"], policy);
    assert.deepEqual(prepared, { placements: [], deferred: [] }, "an upcoming active view was treated as a dormant surface");
    assert.deepEqual(calls.find(({ name }) => name === "syncSurfaces")?.request.surfaces, [],
      "the undrawn record sent an active tab before its plane slot existed");

    calls.length = 0;
    const drawn = await placeCompositorRecord({ surfaces: [view], settled: true, drawn: true, titlebar: 40 }, [view],
      (request) => host.surfaces.place(request), ["placement-probe"], policy);
    assert.deepEqual(drawn.placements.map(({ id }) => id), [view.id], "the active view did not enter the drawn placement");
    assert.deepEqual(calls.find(({ name }) => name === "syncSurfaces")?.request.surfaces.map(({ id }) => id), [view.id]);
  } finally {
    dom.window.close();
  }
});

test("an unloaded cold view is classified before a drawn host placement", async (t) => {
  const dom = new JSDOM('<div id="plane"></div>', { url: "https://example.test/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const mounted = new Set();
  const calls = [];
  const memory = createMemorySaver({
    now: () => 0, enabled: () => true, delay: () => 1,
    declaration: () => "unload", keeps: () => [], kept: () => false, setKept: () => {},
    regions: async () => [], interaction: async () => {}, restore: () => {},
    commit: () => Promise.resolve(), showLabel: () => {}, changed: () => {}, failed: (text) => { throw new Error(text); },
    stateChanged: () => {},
  });
  t.mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: (id) => mounted.has(id) ? { surfaceId: id, disposed: false } : null,
    authorizeSurface: (id) => { mounted.add(id); },
    mountSurface: async (slot, surface) => { mounted.add(surface.surfaceId); },
    waitSurfaceCompositionDeclared: async (id) => {
      if (!mounted.has(id)) throw new Error(`surface ${id} is not mounted`);
    },
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {}, page: (path) => path,
    call: async (name, request) => {
      calls.push({ name, request });
      if (name === "log") return clockAnswer(name, request);
      if (name === "setTheme") return null;
      if (name === "syncSurfaces") return { ticket: 1,
        placements: request.surfaces.map(({ id, x, y, w, h }) => ({ id, visible: true, x, y, w, h })),
        chrome: { controls: { x: 0, y: 0, w: 0, h: 0 }, row: request.titlebar } };
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });

  try {
    const host = await import("../host.js?memory-classification-placement");
    const { placeCompositorRecord } = await import("../compositor.js?memory-classification-placement");
    await host.surfaces.theme({ scheme: "dark", tokens: {} });
    calls.length = 0;
    const cold = { id: "cold-unload-view", plugin: "placement-probe", dim: false, visible: false,
      applied: { x: 0, y: 0, w: 0, h: 0 },
      surface: { surfaceId: "cold-unload-view", pluginId: "placement-probe",
        composition: { kind: "view", page: "ui/page.html" } }, start: { origin: { directory: null } } };
    const candidates = [cold];
    let initialized = false;
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const observe = (_record, tabs) => {
      if (initialized) memory.observe(new Set(), tabs.map(({ id, plugin }) => ({ id, plugin })));
    };
    const undrawn = { surfaces: [], settled: true, drawn: false, titlebar: 40 };
    const beforeDraw = await memoryPlacement(undrawn, candidates, { ready, saver: memory, observe });
    const prepared = await placeCompositorRecord(undrawn, beforeDraw.surfaces,
      (request) => host.surfaces.place(request), ["placement-probe"], {
        mountedSurface: (id) => mounted.has(id) ? { surfaceId: id, disposed: false } : null,
        prepare: async (surface) => {
          const slot = document.createElement("div");
          slot.hidden = true;
          document.body.append(slot);
          mounted.add(surface.surface.surfaceId);
        },
      });
    assert.deepEqual(prepared, { placements: [], deferred: [] }, "an undrawn preparation waited for startup classification");
    assert.deepEqual(calls.find(({ name }) => name === "syncSurfaces")?.request.surfaces, [],
      "an undrawn preparation sent a cold hidden view");
    assert.equal(mounted.has(cold.id), false, "an undrawn preparation mounted a cold hidden view");

    let classificationFinished = false;
    const drawn = { surfaces: [], settled: true, drawn: true, titlebar: 40 };
    const classifiedPlacement = memoryPlacement(drawn, candidates, { ready, saver: memory, observe }).then((value) => {
      classificationFinished = true;
      return value;
    });
    await Promise.resolve();
    assert.equal(classificationFinished, false, "drawn placement did not wait for startup memory classification");
    memory.observe(new Set(), [{ id: cold.id, plugin: cold.plugin }]);
    memory.start();
    initialized = true;
    resolveReady();
    const classified = await classifiedPlacement;
    const answer = await placeCompositorRecord(drawn, classified.surfaces,
      (request) => host.surfaces.place(request), ["placement-probe"], {
        mountedSurface: (id) => mounted.has(id) ? { surfaceId: id, disposed: false } : null,
        prepare: async (surface) => {
          mounted.add(surface.surface.surfaceId);
        },
      });

    assert.deepEqual(answer.placements, [], "an unload-declared hidden tab entered the drawn compositor record");
    assert.deepEqual(calls.find(({ name }) => name === "syncSurfaces")?.request.surfaces, [],
      "startup placed a cold hidden view after the memory saver classified it as unloaded");
    assert.equal(mounted.has(cold.id), false, "startup mounted a hidden tab that should start unloaded");
    assert.equal(memory.state(cold.id), "unloaded", "the enabled memory saver did not classify the cold tab as unloaded");

    const startupFailure = new Error("tab state initialization failed");
    let rejectReady;
    const failedReady = new Promise((_resolve, reject) => { rejectReady = reject; });
    let observedAfterFailure = false;
    const waiting = [1, 2].map(() => memoryPlacement(drawn, candidates, {
      ready: failedReady, saver: memory,
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
});

test("a disabled memory saver mounts a cold hidden view at startup", async (t) => {
  const dom = new JSDOM('<div id="plane"></div>', { url: "https://example.test/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const mounted = new Set();
  const calls = [];
  const memory = createMemorySaver({
    now: () => 0, enabled: () => false, delay: () => 1,
    declaration: () => "unload", keeps: () => [], kept: () => false, setKept: () => {},
    regions: async () => [], interaction: async () => {}, restore: () => {},
    commit: () => Promise.resolve(), showLabel: () => {}, changed: () => {}, failed: (text) => { throw new Error(text); },
    stateChanged: () => {},
  });
  t.mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: (id) => mounted.has(id) ? { surfaceId: id, disposed: false } : null,
    authorizeSurface: (id) => { mounted.add(id); },
    mountSurface: async (slot, surface) => { mounted.add(surface.surfaceId); },
    waitSurfaceCompositionDeclared: async (id) => {
      if (!mounted.has(id)) throw new Error(`surface ${id} is not mounted`);
    },
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {}, page: (path) => path,
    call: async (name, request) => {
      calls.push({ name, request });
      if (name === "log") return clockAnswer(name, request);
      if (name === "setTheme") return null;
      if (name === "syncSurfaces") return { ticket: 1,
        placements: request.surfaces.map(({ id, x, y, w, h }) => ({ id, visible: true, x, y, w, h })),
        chrome: { controls: { x: 0, y: 0, w: 0, h: 0 }, row: request.titlebar } };
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  try {
    const host = await import("../host.js?memory-saver-disabled-placement");
    const { placeCompositorRecord } = await import("../compositor.js?memory-saver-disabled-placement");
    const retainedMounts = await import("../retained-surface-mounts.js?memory-saver-disabled-placement");
    await host.surfaces.theme({ scheme: "dark", tokens: {} });
    calls.length = 0;
    const cold = { id: "cold-loaded-view", plugin: "placement-probe", dim: false, visible: false,
      applied: { x: 0, y: 0, w: 0, h: 0 },
      surface: { surfaceId: "cold-loaded-view", pluginId: "placement-probe",
        composition: { kind: "view", page: "ui/page.html" } }, start: { origin: { directory: null } } };
    const candidates = [cold];
    memory.observe(new Set(), [{ id: cold.id, plugin: cold.plugin }]);
    memory.start();
    const classified = await memoryPlacement({ surfaces: [], drawn: true }, candidates, {
      ready: Promise.resolve(), saver: memory,
      observe: (_record, tabs) => memory.observe(new Set(), tabs.map(({ id, plugin }) => ({ id, plugin }))),
    });
    const answer = await placeCompositorRecord({ surfaces: [], drawn: true, settled: true, titlebar: 40 },
      classified.surfaces, (request) => host.surfaces.place(request), ["placement-probe"], {
        mountedSurface: (id) => mounted.has(id) ? { surfaceId: id, disposed: false } : null,
        prepare: retainedMounts.prepareRetainedSurface,
      });

    assert.equal(memory.state(cold.id), "loaded", "a disabled memory saver unloaded a hidden tab");
    assert.deepEqual(calls.find(({ name }) => name === "syncSurfaces")?.request.surfaces.map(({ id }) => id), [cold.id],
      "a disabled memory saver did not mount its hidden view at startup");
    assert.deepEqual(answer.placements, [], "a hidden cold view entered the empty compositor record");
    retainedMounts.releaseRetainedSurfaceSlots({ surfaces: [] }, new Set([cold.id]));
  } finally {
    dom.window.close();
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { logGate } from "../log-gate.js";
import { registerPlugin } from "../registry.js";

const pluginId = "fixture-start-handoff";

test("core.file.open parameters reach the host placement request", { timeout: 5000 }, async (t) => {
  const hostCalls = [];
  let heldSync = null;
  const syncReply = (request) => ({
    placements: request.surfaces.map(({ id, visible, x, y, w, h }) => ({ id, visible, x, y, w, h })),
    chrome: { controls: { x: 0, y: 0, w: 0, h: 0 }, row: request.titlebar },
  });
  const bridge = {
    on: () => () => {},
    page: (path) => path,
    reload: () => {},
    call: async (name, request) => {
      hostCalls.push({ name, request });
      if (name === "log" && request.action === "clock") return { ts_us: 1_791_000_000_000_456, mono_ns: 5_000_000_789 };
      if (name === "log") return null;
      if (name === "syncSurfaces") {
        if (heldSync !== null) {
          const pending = heldSync;
          heldSync = null;
          pending.start(request);
          return pending.answer;
        }
        return syncReply(request);
      }
      if (name === "presentSurfaces") return request.placements;
      if (name === "notificationState") return { authorization: "notDetermined", error: null };
      return null;
    },
  };
  t.mock.module("@soksak/runtime", { exports: { host: bridge, page: null, windows: null,
    openStore: () => { throw new Error("the fixture does not open a store"); } } });
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  const planeElement = document.getElementById("plane");
  Object.defineProperty(planeElement, "clientWidth", { value: 800 });
  Object.defineProperty(planeElement, "clientHeight", { value: 600 });
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  t.mock.module("../environment.js", { exports: {
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "main" }] }],
    } } }),
    pluginUnits: () => [{ id: pluginId, name: "Fixture", version: "0.0.1", description: "Fixture surface.", surface: true, sections: [] }],
    pluginDiagnostics: async () => null,
  } });
  registerPlugin({
    id: pluginId, name: "Fixture", mark: "f", svg: "<path/>", ink: null, background: null, drop: null,
    params: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    opens: ["txt"],
    surface: (surfaceId) => ({ composition: { kind: "view", page: "ui/index.html" }, surfaceId, pluginId,
      declarations: {}, sidecars: [] }),
  });

  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  const compositor = await import("../compositor.js");
  const { authorizeSurface, surfacePlacementsForHost, viewStartValues } = await import("../surface-modules.js");
  const { recordOrigin } = await import("../tab-reports.js");
  const { surfaces: hostSurfaces } = await import("../host.js");
  const holdNextSync = () => {
    let resolveAnswer;
    let resolveStarted;
    const answer = new Promise((resolve) => { resolveAnswer = resolve; });
    const started = new Promise((resolve) => { resolveStarted = resolve; });
    heldSync = { answer, start: resolveStarted };
    return { started, resolve: resolveAnswer };
  };
  const surfaceSyncEvents = () => hostCalls.filter(({ name }) => name === "log")
    .flatMap(({ request }) => request.events ?? [])
    .filter(({ event }) => event === "page.trace.surface.sync");
  try {
    const startValuesSurfaces = ["tab-snapshot-one", "tab-snapshot-two"].map((surfaceId) => {
      recordOrigin(surfaceId, null, "test fixture");
      return { id: surfaceId, surface: {
        surfaceId, pluginId, params: null, declarations: { status: [], commands: [], dom: [] },
        composition: { kind: "view", page: "ui/index.html" },
      } };
    });
    const currentDeclarations = registry.surfaceDeclarations;
    let declarationReads = 0;
    registry.surfaceDeclarations = () => {
      const version = ++declarationReads;
      return Object.fromEntries(["status", "commands", "dom"].map((kind) => [kind, [
        { name: `core.${kind}.snapshot-${version}` },
      ]]));
    };
    try {
      const starts = surfacePlacementsForHost(startValuesSurfaces, null, () => "the drawn record").map(({ start }) => start);
      assert.equal(declarationReads, 1,
        "one placement must project the complete declaration registry once, not three times for each view");
      for (const start of starts) {
        for (const kind of ["status", "commands", "dom"]) {
          assert.equal(start.declarations[kind][0].name, `core.${kind}.snapshot-1`,
            `${kind} declarations came from a different registry snapshot`);
        }
      }
      const directStart = viewStartValues(startValuesSurfaces[0].surface, null);
      assert.equal(declarationReads, 2, "a direct single-view start-value calculation must read one declaration snapshot");
      for (const kind of ["status", "commands", "dom"]) {
        assert.equal(directStart.declarations[kind][0].name, `core.${kind}.snapshot-2`);
      }
    } finally {
      registry.surfaceDeclarations = currentDeclarations;
    }

    let draw;
    plane.onLayout((_made, next) => { draw = next; });
    plane.adopt(plane.fresh());
    draw();

    await compositor.publish();
    const initial = compositor.latest();
    authorizeSurface(initial.surfaces[0].id);
    await hostSurfaces.theme({ scheme: "light", tokens: {} });
    const previousLogPolicy = logGate.classes();
    logGate.set({ ...previousLogPolicy, frame: "trace" });
    try {
      await hostSurfaces.place({ ...initial, surfaces: surfacePlacementsForHost(initial.surfaces, null, () => "the drawn record") });
    } finally {
      logGate.set(previousLogPolicy);
    }
    await new Promise((resolve) => setImmediate(resolve));
    const initialSync = hostCalls.filter(({ name }) => name === "syncSurfaces").at(-1);
    assert.ok(Array.isArray(initialSync.request.declarations), "the wire request omitted its declaration table");
    assert.equal(Number.isSafeInteger(initialSync.request.surfaces[0].start.declarations), true,
      "the host request did not replace nested declarations with a table index");
    assert.ok(initialSync.request.declarations[initialSync.request.surfaces[0].start.declarations],
      "the request-local declaration index does not resolve to an object");
    const syncTrace = hostCalls.filter(({ name }) => name === "log")
      .flatMap(({ request }) => request.events ?? [])
      .find(({ event }) => event === "page.trace.surface.sync");
    assert.ok(syncTrace, "the frame gate did not record surface sync while the performance trace was off");
    assert.equal(syncTrace.fields.declarationTableBytes > 0, true,
      "the sync event omitted the normalized declaration component size");
    assert.equal(syncTrace.fields.declarationInlineBytes > 0, true,
      "the sync event omitted the pre-normalized declaration component size");

    const priorTracePolicy = logGate.classes();
    try {
      logGate.set({ ...priorTracePolicy, frame: "off" });
      const opensBeforeCompletion = holdNextSync();
      const openingPlacement = hostSurfaces.place({ ...initial, settled: false,
        surfaces: surfacePlacementsForHost(initial.surfaces, null, () => "the drawn record") });
      const openingRequest = await opensBeforeCompletion.started;
      logGate.set({ ...priorTracePolicy, frame: "trace" });
      opensBeforeCompletion.resolve(syncReply(openingRequest));
      await openingPlacement;
      await new Promise((resolve) => setImmediate(resolve));
      const afterOpening = surfaceSyncEvents();
      assert.equal(afterOpening.length, 2,
        "a frame gate opened while sync was pending must record the completed request");
      assert.ok(afterOpening[1].fields.declarationInlineBytes > 0 && afterOpening[1].fields.declarationTableBytes > 0,
        "completion-time measurement omitted declaration component bytes");

      const closesBeforeCompletion = holdNextSync();
      const closingPlacement = hostSurfaces.place({ ...initial, settled: true,
        surfaces: surfacePlacementsForHost(initial.surfaces, null, () => "the drawn record") });
      const closingRequest = await closesBeforeCompletion.started;
      logGate.set({ ...priorTracePolicy, frame: "off" });
      closesBeforeCompletion.resolve(syncReply(closingRequest));
      await closingPlacement;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(surfaceSyncEvents().length, 2,
        "a frame gate closed while sync was pending must omit the completed request record");
    } finally {
      logGate.set(priorTracePolicy);
    }

    assert.strictEqual(initialSync.request.surfaces[0].start.params, null,
      "a tab without stored parameters did not preserve explicit null in the host request");

    const opened = plane.openFile("sample.txt");
    assert.equal(typeof draw, "function", "core.file.open did not schedule a layout draw");
    draw();
    const slot = document.querySelector(`[data-native-surface-id="${opened.tab}"]`);
    assert.ok(slot?.querySelector(":scope > .surface-module-host"), "the actual view mount did not run");

    await compositor.publish();
    const record = compositor.latest();
    const surfaces = surfacePlacementsForHost(record.surfaces, null, () => "the drawn record");
    authorizeSurface(opened.tab);
    await hostSurfaces.theme({ scheme: "light", tokens: {} });
    await hostSurfaces.place({ ...record, surfaces });
    const dispatched = hostCalls.filter(({ name }) => name === "syncSurfaces")
      .flatMap(({ request }) => request.surfaces.map((surface) => ({ request, surface })))
      .find(({ surface }) => surface.id === opened.tab);
    assert.ok(dispatched, "the host did not receive the file-open surface");
    assert.deepEqual(record.surfaces.find(({ id }) => id === opened.tab)?.surface.params, { path: "sample.txt" },
      "the compositor record did not preserve the plane's full descriptor");
    assert.equal(dispatched.surface.params, undefined, "the syncSurfaces wire gained a duplicate params field");
    assert.deepEqual(dispatched.surface.start.params, { path: "sample.txt" },
      "the first host placement did not retain the actual file-open descriptor");

    const { surfaceForTab } = await import("../surface-modules.js");
    recordOrigin("tab-dormant", null, "test fixture");
    const dormant = surfaceForTab({ id: "tab-dormant", plugin: pluginId, params: { path: "stored.txt" } });
    assert.deepEqual(dormant.params, { path: "stored.txt" }, "a dormant tab descriptor lost stored params");
    const dormantPlacement = surfacePlacementsForHost([{ id: dormant.surfaceId, surface: dormant }], null, () => "the drawn record")[0];
    assert.deepEqual(dormantPlacement.start.params, { path: "stored.txt" });
    recordOrigin("tab-null", null, "test fixture");
    const explicitNull = surfaceForTab({ id: "tab-null", plugin: pluginId, params: null });
    assert.strictEqual(explicitNull.params, null, "a dormant tab without params lost explicit null");
    assert.strictEqual(surfacePlacementsForHost([{ id: explicitNull.surfaceId, surface: explicitNull }], null, () => "the drawn record")[0].start.params, null);
  } finally {
    dom.window.close();
  }
});

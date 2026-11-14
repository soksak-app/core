import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { logGate } from "../log-gate.js";
import { drained } from "./support/drained.mjs";

const pluginId = "fixture-start-handoff";

// The host calls of the test are answered by its page-wire case (docs/spec/cases/page-wire/README.md). The case is selected before the
// first module that imports host.js is imported, because host.js reads the host when it is imported. A reply that the test holds is
// released at the point where the test lets the host answer.
test("core.file.open parameters reach the host placement request", { timeout: 5000 }, async () => {
  const wire = selectPageWire("view-start-handoff-file-open");
  // The calls of the page to the host, as {name, request}.
  const hostCalls = () => wire.calls.map(({ name, payload }) => ({ name, request: payload }));
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // The plane aligns itself to the device pixel grid of this scale on every draw (device-grid.js).
  globalThis.devicePixelRatio = dom.window.devicePixelRatio;
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

  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "main" }] }],
    } },
  }, { plugins: [{ id: pluginId, package: "@fixture/start-handoff", version: "0.0.1", manifest: {
    id: pluginId, name: "Fixture", description: "Fixture surface.", mark: "f", icon: "<path/>",
    surface: {
      composition: { kind: "view", page: "ui/index.html" },
      params: { type: "object", properties: { path: { type: "string" } } },
      opens: { extensions: ["txt"] },
    },
  } }] }), [], "the fixture environment refused a plugin");

  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  const compositor = await import("../compositor.js");
  const { authorizeSurface, surfacePlacementsForHost, viewStartProjectOf, viewStartValues } = await import("../surface-modules.js");
  const { recordOrigin } = await import("../tab-reports.js");
  const { surfaces: hostSurfaces } = await import("../host.js");
  // The records of the frame gate are queued and relayed in batches; flushEvents ends when every queued record was relayed.
  const { flushEvents } = await import("../page-log.js");
  const surfaceSyncEvents = () => hostCalls().filter(({ name }) => name === "log")
    .flatMap(({ request }) => request.events ?? [])
    .filter(({ event }) => event === "workbench.trace.surface.sync");
  try {
    const startValuesSurfaces = ["tab-snapshot-one", "tab-snapshot-two"].map((surfaceId) => {
      recordOrigin(surfaceId, null, "test fixture");
      return { id: surfaceId, surface: {
        surfaceId, pluginId, params: null, declarations: { status: [], commands: [], element: [] },
        composition: { kind: "view", page: "ui/index.html" },
      } };
    });
    // The count of the reads of the declaration registry cannot be seen from its results, so the method of the registry counts its reads
    // for this block, and the block restores it.
    const currentDeclarations = registry.surfaceDeclarations;
    let declarationReads = 0;
    registry.surfaceDeclarations = () => {
      const version = ++declarationReads;
      return Object.fromEntries(["status", "commands", "element"].map((kind) => [kind, [
        { name: `core.${kind}.snapshot-${version}` },
      ]]));
    };
    try {
      const starts = surfacePlacementsForHost(startValuesSurfaces, null, () => "the drawn record").map(({ start }) => start);
      assert.equal(declarationReads, 1,
        "one placement must project the complete declaration registry once, not three times for each view");
      for (const start of starts) {
        for (const kind of ["status", "commands", "element"]) {
          assert.equal(start.declarations[kind][0].name, `core.${kind}.snapshot-1`,
            `${kind} declarations came from a different registry snapshot`);
        }
      }
      const directStart = viewStartValues(startValuesSurfaces[0].surface, null);
      assert.equal(declarationReads, 2, "a direct single-view start-value calculation must read one declaration snapshot");
      for (const kind of ["status", "commands", "element"]) {
        assert.equal(directStart.declarations[kind][0].name, `core.${kind}.snapshot-2`);
      }
    } finally {
      registry.surfaceDeclarations = currentDeclarations;
    }

    let draw;
    plane.onLayout((_made, next) => { draw = next; });
    plane.adopt(plane.fresh(), "spc-aaaaaa");
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
    await flushEvents();
    const initialSync = hostCalls().filter(({ name }) => name === "syncSurfaces").at(-1);
    assert.ok(Array.isArray(initialSync.request.declarations), "the wire request omitted its declaration table");
    assert.equal(Number.isSafeInteger(initialSync.request.surfaces[0].start.declarations), true,
      "the host request did not replace nested declarations with a table index");
    assert.ok(initialSync.request.declarations[initialSync.request.surfaces[0].start.declarations],
      "the request-local declaration index does not resolve to an object");
    const syncTrace = hostCalls().filter(({ name }) => name === "log")
      .flatMap(({ request }) => request.events ?? [])
      .find(({ event }) => event === "workbench.trace.surface.sync");
    assert.ok(syncTrace, "the frame gate did not record surface sync while the performance trace was off");
    assert.equal(syncTrace.fields.declarationTableBytes > 0, true,
      "the sync event omitted the normalized declaration component size");
    assert.equal(syncTrace.fields.declarationInlineBytes > 0, true,
      "the sync event omitted the pre-normalized declaration component size");

    const priorTracePolicy = logGate.classes();
    try {
      logGate.set({ ...priorTracePolicy, frame: "off" });
      const openingPlacement = hostSurfaces.place({ ...initial, settled: false,
        surfaces: surfacePlacementsForHost(initial.surfaces, null, () => "the drawn record") });
      // The host holds the reply of the request, and the end of the microtask queue follows the call that sends it.
      await drained();
      assert.equal(wire.calls.at(-1).name, "syncSurfaces", "the placement did not send its request");
      logGate.set({ ...priorTracePolicy, frame: "trace" });
      wire.release();
      await openingPlacement;
      await flushEvents();
      const afterOpening = surfaceSyncEvents();
      assert.equal(afterOpening.length, 2,
        "a frame gate opened while sync was pending must record the completed request");
      assert.deepEqual([afterOpening[1].fields.declarationInlineBytes, afterOpening[1].fields.declarationTableBytes], [0, 2],
        "a request with start values that the host holds did not measure an empty declaration table");

      const closingPlacement = hostSurfaces.place({ ...initial, settled: true,
        surfaces: surfacePlacementsForHost(initial.surfaces, null, () => "the drawn record") });
      await drained();
      assert.equal(wire.calls.at(-1).name, "syncSurfaces", "the placement did not send its request");
      logGate.set({ ...priorTracePolicy, frame: "off" });
      wire.release();
      await closingPlacement;
      await flushEvents();
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
    const dispatched = hostCalls().filter(({ name }) => name === "syncSurfaces")
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
    // The view calls of the view answer for the project that its last placement named (view-calls.js).
    assert.equal(viewStartProjectOf("tab-dormant"), null, "a placement with no project names none for the view");
    surfacePlacementsForHost([{ id: dormant.surfaceId, surface: dormant }], { id: "p-dormant", root: "/work/p-dormant" }, () => "the drawn record");
    assert.deepEqual(viewStartProjectOf("tab-dormant"), { id: "p-dormant", root: "/work/p-dormant" });
    recordOrigin("tab-null", null, "test fixture");
    const explicitNull = surfaceForTab({ id: "tab-null", plugin: pluginId, params: null });
    assert.strictEqual(explicitNull.params, null, "a dormant tab without params lost explicit null");
    assert.strictEqual(surfacePlacementsForHost([{ id: explicitNull.surfaceId, surface: explicitNull }], null, () => "the drawn record")[0].start.params, null);
    // The records that the last calls queued are relayed before the page closes, so the case holds each call of the page.
    await flushEvents();
  } finally {
    dom.window.close();
  }
  wire.finish();
});

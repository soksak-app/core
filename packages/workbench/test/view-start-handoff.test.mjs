import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const pluginId = "fixture-start-handoff";

test("core.file.open parameters reach the host placement request", { timeout: 5000 }, async (t) => {
  const hostCalls = [];
  const bridge = {
    on: () => () => {},
    page: (path) => path,
    reload: () => {},
    call: async (name, request) => {
      hostCalls.push({ name, request });
      if (name === "syncSurfaces") return {
        placements: request.surfaces.map(({ id, visible, x, y, w, h }) => ({ id, visible, x, y, w, h })),
        chrome: { controls: { x: 0, y: 0, w: 0, h: 0 }, row: 40 },
      };
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
  const { authorizeSurface, surfacePlacementsForHost } = await import("../surface-modules.js");
  const { recordOrigin } = await import("../tab-reports.js");
  const { surfaces: hostSurfaces } = await import("../host.js");
  try {
    let draw;
    plane.onLayout((_made, next) => { draw = next; });
    plane.adopt(plane.fresh());
    draw();

    await compositor.publish();
    const initial = compositor.latest();
    authorizeSurface(initial.surfaces[0].id);
    await hostSurfaces.theme({ scheme: "light", tokens: {} });
    await hostSurfaces.place({ ...initial, surfaces: surfacePlacementsForHost(initial.surfaces, null) });
    const initialSync = hostCalls.filter(({ name }) => name === "syncSurfaces").at(-1);
    assert.strictEqual(initialSync.request.surfaces[0].start.params, null,
      "a tab without stored parameters did not preserve explicit null in the host request");

    const opened = plane.openFile("sample.txt");
    assert.equal(typeof draw, "function", "core.file.open did not schedule a layout draw");
    draw();
    const slot = document.querySelector(`[data-native-surface-id="${opened.tab}"]`);
    assert.ok(slot?.querySelector(":scope > .surface-module-host"), "the actual view mount did not run");

    await compositor.publish();
    const record = compositor.latest();
    const surfaces = surfacePlacementsForHost(record.surfaces, null);
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
    const dormantPlacement = surfacePlacementsForHost([{ id: dormant.surfaceId, surface: dormant }], null)[0];
    assert.deepEqual(dormantPlacement.start.params, { path: "stored.txt" });
    recordOrigin("tab-null", null, "test fixture");
    const explicitNull = surfaceForTab({ id: "tab-null", plugin: pluginId, params: null });
    assert.strictEqual(explicitNull.params, null, "a dormant tab without params lost explicit null");
    assert.strictEqual(surfacePlacementsForHost([{ id: explicitNull.surfaceId, surface: explicitNull }], null)[0].start.params, null);
  } finally {
    dom.window.close();
  }
});

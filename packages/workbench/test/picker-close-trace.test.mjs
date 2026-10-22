// Closing the native picker writes the page trace event `page.trace.picker.close` with the reason of the close
// (docs/spec/performance-trace.md#producers).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { mock } from "node:test";
import { registerPlugin } from "../registry.js";

const pluginId = "fixture-picker-close";

test("closing the picker writes picker.close with the reason of the close", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  const reports = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: { ...actualHost, report: (line) => reports.push(line) } });
  const actualPerformance = await import("../performance.js");
  const traced = [];
  t.mock.module("../performance.js", { exports: {
    ...actualPerformance,
    trace: (event, fields = {}) => { traced.push({ event, fields }); },
  } });
  t.mock.module("../surface-modules.js", { exports: {
    mountedSurface: () => null,
    mountSurface: () => Promise.resolve(),
    disposeSurface: () => Promise.resolve(), placePluginPlaceholder: () => {},
  } });
  t.mock.module("../environment.js", { exports: {
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "main" }] }],
    } } }),
    pluginUnits: () => [{ id: pluginId, name: "Fixture", description: "검사용 표면.", surface: true, sections: [] }],
  } });
  registerPlugin({
    id: pluginId, name: "Fixture", mark: "f", svg: "<path/>", ink: null, background: null, drop: null,
    surface: (surfaceId) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId, pluginId,
      declarations: {}, sidecars: [] }),
  });

  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  try {
    let held = null;
    plane.onLayout((made, draw) => { held = { made, draw }; });
    plane.adopt(plane.fresh());
    held.draw();
    plane.openCardTabs("main");
    assert.equal(plane.pickerState().open, true, "the tab list of the card did not open");
    traced.length = 0;
    plane.closePicker("dismiss");
    assert.deepEqual(traced, [{ event: "picker.close", fields: { reason: "dismiss" } }]);
    assert.deepEqual(reports, []);
  } finally {
    dom.window.close();
  }
});

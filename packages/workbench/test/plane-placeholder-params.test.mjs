// A stored tab whose params do not match the declaration of its loaded plugin opens as a placeholder (docs/spec/plugins.md#pluginjson). The mismatch
// is a failure of the stored data, so its line goes through the one error display path with the place of its surface, and the path withdraws it when
// the surface leaves (F217). The text names the plugin, its version and the mismatch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const pluginId = "fixture-placeholder-params";
const version = "0.0.1";

test("a stored tab whose params do not match its plugin is an error shown once, and withdrawn when its surface leaves", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  // matchMedia, which JSDOM does not have. The view uses it only to subscribe to resolution changes, and this test does not change the resolution.
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  // The size of the plane. JSDOM does not compute layout, so the test gives a size that has space to split.
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  // The border width that the app stylesheet gives a card. JSDOM does not load app.css.
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  // The page without a host bridge records the reports, so the test reads the lines that the error display path writes to the application log.
  // The mocks are set before the error display module is imported, so that module reports through the mock.
  const reports = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: { ...actualHost, report: (line) => reports.push(line) } });
  // The calls of the error display path, so the test sees each show and each withdrawal of a place.
  const errorCalls = [];
  const actualErrors = await import("../shown-errors.js");
  t.mock.module("../shown-errors.js", { exports: {
    showError: (element, where, text, detail) => {
      errorCalls.push({ kind: "show", where, text });
      return actualErrors.showError(element, where, text, detail);
    },
    hideError: (element, where) => {
      errorCalls.push({ kind: "hide", where });
      return actualErrors.hideError(element, where);
    },
  } });
  const actualInstalled = await import("../installed-plugins.js");
  t.mock.module("../installed-plugins.js", { exports: { ...actualInstalled,
    pluginOperations: { hosted: true, failure: () => null, status: () => ({ plugins: [] }) },
    onPluginOperations: () => {},
  } });
  // The test does not load surface modules. The placeholder joins the slot of its tab, and the mounted surface of the valid tab is only recorded.
  t.mock.module("../surface-modules.js", { exports: {
    mountedSurface: () => null,
    mountSurface: (slot, surface) => { mountedSurfaces.push(surface); return Promise.resolve(); },
    disposeSurface: () => Promise.resolve(), focusSurface: () => true,
    placePluginPlaceholder: (slot, surfaceId, element) => slot.append(element),
  } });
  // The card holds a tab whose stored params do not match the declaration, and a tab whose params match it.
  const mismatched = { path: 5 };
  const mountedSurfaces = [];
  t.mock.module("../environment.js", { exports: {
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [
        { plugin: pluginId, title: "bad" },
        { plugin: pluginId, title: "good" },
      ] }],
    } } }),
    pluginUnits: () => [{ id: pluginId, name: "Fixture", version, description: "검사용 표면.", surface: true, sections: [] }],
    pluginDiagnostics: async () => null,
  } });
  registerPlugin({
    id: pluginId, name: "Fixture", mark: "f", svg: "<path/>", ink: null, background: null, drop: null,
    params: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    opens: ["txt"],
    surface: (surfaceId) => ({ composition: { kind: "view", page: "ui/index.html" }, surfaceId, pluginId,
      declarations: {}, sidecars: [] }),
  });

  // The card elements connect only to declared core commands.
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  try {
    let held = null;
    plane.onLayout((made, draw) => { held = draw; });
    const drawHeld = () => { const draw = held; held = null; draw(); };
    // A saved space keeps the params of its tabs. The environment layout starts tabs without params, so the test stores them in the saved state.
    const kept = plane.fresh();
    for (const tab of kept.state.cards.find((card) => card.id === "main").data.tabs) {
      tab.params = tab.title === "bad" ? mismatched : { path: "ok" };
    }
    plane.adopt(kept);
    drawHeld();
    // The first tab is active, so its placeholder is drawn. The stored params of the tab are kept as they were stored.
    const tabs = plane.currentGrid().card("main").data.tabs;
    const badTab = tabs.find((tab) => tab.title === "bad");
    assert.deepEqual(badTab.params, mismatched, "the stored params of the placeholder tab were not kept");
    assert.equal(plane.currentGrid().card("main").data.activeId, badTab.id, "the placeholder tab is not the active tab");
    const where = `surface ${badTab.id} placeholder`;
    const text = `${pluginId} ${version} 탭의 인자가 선언과 맞지 않습니다: params do not match ${pluginId} surface.params`;
    const shows = errorCalls.filter((call) => call.kind === "show");
    assert.deepEqual(shows, [{ kind: "show", where, text }], "the mismatched params did not show exactly one error for their surface");
    assert.deepEqual(reports, [`${where}: ${text}`], "the mismatched params did not write their error to the application log");

    // Closing the placeholder tab removes its surface, so the error of its place is withdrawn.
    await plane.closeTabById(badTab.id);
    assert.notEqual(held, null, "closing the tab did not hold a layout draw");
    drawHeld();
    assert.ok(errorCalls.some((call) => call.kind === "hide" && call.where === where), "closing the surface did not withdraw its error");
    assert.equal(errorCalls.filter((call) => call.kind === "show").length, 1, "withdrawing the error wrote it again");

    const { viewStartValues } = await import("../surface-modules.js?view-file-open-params");
    const opened = plane.openFile("sample.txt");
    assert.equal(opened.tab, plane.currentGrid().card("main").data.activeId);
    assert.deepEqual(plane.currentGrid().card("main").data.tabs.find(({ id }) => id === opened.tab).params, { path: "sample.txt" });
    assert.notEqual(held, null, "opening the file did not schedule a layout draw");
    drawHeld();
    const surface = mountedSurfaces.find(({ surfaceId }) => surfaceId === opened.tab);
    assert.ok(surface, "core.file.open did not produce a mounted view surface");
    assert.deepEqual(surface.params, { path: "sample.txt" }, "the mounted surface did not receive the tab params");
    assert.deepEqual(viewStartValues(surface, { id: "prj-open", root: "/work/project" }).params, { path: "sample.txt" },
      "the producer start values did not preserve the file-open path");
  } finally {
    dom.window.close();
  }
});

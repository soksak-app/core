// A tab whose plugin is not loaded opens as a placeholder card (docs/spec/plugins.md#plugins-that-are-not-loaded). The reason unread states a failure
// to read the install state, so its line goes through the one error display path with the surface in its place, and the path withdraws it when the
// surface leaves (F217). The other reasons are ordinary placeholder text and write no error.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const pluginId = "fixture-placeholder-error";
const missingId = "fixture-not-registered";
const readFailure = "read failed";

test("a placeholder whose install state cannot be read is an error shown once, and withdrawn when its surface leaves", { timeout: 5000 }, async (t) => {
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
  // This mock is set before the error display module is imported, so that module reports through the mock.
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
  // The plugin state cannot be read, so the placeholder of a tab whose plugin is not loaded has the reason unread.
  const actualInstalled = await import("../installed-plugins.js");
  t.mock.module("../installed-plugins.js", { exports: { ...actualInstalled,
    pluginOperations: { hosted: true, failure: () => ({ kind: "state", message: readFailure }), status: () => ({ plugins: [] }) },
  } });
  // The test does not load surface modules. The placeholder joins the slot of its tab, and the mounted surface of the registered plugin is only recorded.
  t.mock.module("../surface-modules.js", { exports: {
    mountedSurface: () => null,
    surfaceForTab: (tab) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId: tab.id,
      pluginId: tab.plugin, declarations: {}, sidecars: [] }),
    mountSurface: () => Promise.resolve(),
    disposeSurface: () => Promise.resolve(), focusSurface: () => true,
    placePluginPlaceholder: (slot, surfaceId, element) => slot.append(element),
  } });
  // The card of the layout holds a tab of a plugin that is not registered and a tab of a registered plugin.
  t.mock.module("../environment.js", { exports: {
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: missingId, title: "gone" }, { plugin: pluginId, title: "main" }] }],
    } } }),
    pluginUnits: () => [{ id: pluginId, name: "Fixture", description: "검사용 표면.", surface: true, sections: [] }],
  } });
  registerPlugin({
    id: pluginId, name: "Fixture", mark: "f", svg: "<path/>", ink: null, background: null, drop: null,
    surface: (surfaceId) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId, pluginId,
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
    plane.adopt(plane.fresh());
    drawHeld();
    // The first tab is active, so its placeholder is drawn and the tab of the registered plugin is not.
    const tabs = plane.currentGrid().card("main").data.tabs;
    const missingTab = tabs.find((tab) => tab.plugin === missingId).id;
    const where = `surface ${missingTab} placeholder`;
    const text = `${missingId} 플러그인의 설치 상태를 읽지 못했습니다.`;
    assert.equal(plane.currentGrid().card("main").data.activeId, missingTab, "the placeholder tab is not the active tab");
    const shows = errorCalls.filter((call) => call.kind === "show");
    assert.deepEqual(shows, [{ kind: "show", where, text }], "the unread placeholder did not show exactly one error for its surface");
    assert.deepEqual(reports, [`${where}: ${text}`], "the unread placeholder did not write its error to the application log");
    const shownLine = document.querySelector(`[data-error="${where}"]`);
    assert.equal(shownLine?.textContent, text, "the unread placeholder is not shown on the screen");

    // Closing the placeholder tab removes its surface, so the error of its place is withdrawn.
    await plane.closeTabById(missingTab);
    // The receiver holds the draw of the closing layout until the native preparation finishes, so the test runs it here.
    assert.notEqual(held, null, "closing the tab did not hold a layout draw");
    drawHeld();
    assert.ok(errorCalls.some((call) => call.kind === "hide" && call.where === where), "closing the surface did not withdraw its error");
    assert.equal(errorCalls.filter((call) => call.kind === "show").length, 1, "withdrawing the error wrote it again");
  } finally {
    dom.window.close();
  }
});

// A tab whose plugin is not loaded opens as a placeholder card (docs/spec/plugins.md#plugins-that-are-not-loaded). The reason unread states a failure
// to read the install state, so its line goes through the one error display path with the surface in its place, and the path withdraws it when the
// surface leaves (F217). The other reasons are ordinary placeholder text and write no error.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

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
  // The plane aligns itself to the device pixel grid of this scale on every draw (device-grid.js).
  globalThis.devicePixelRatio = dom.window.devicePixelRatio;
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
  // The plugin state cannot be read, so the placeholder of a tab whose plugin is not loaded has the reason unread. A read of the plugin state needs
  // the host, which this page does not have without a page-wire case; the failure is therefore given by this replacement.
  const actualInstalled = await import("../installed-plugins.js");
  t.mock.module("../installed-plugins.js", { exports: { ...actualInstalled,
    pluginOperations: { hosted: true, failure: () => ({ kind: "state", message: readFailure }), status: () => ({ plugins: [] }) },
  } });
  // The card of the layout holds a tab of a plugin that is not installed and a tab of an installed plugin.
  const { installEnvironment } = await import("../environment.js");
  installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: missingId, title: "gone" }, { plugin: pluginId, title: "main" }] }],
    } },
    sidebars: { sets: [], links: [] },
  }, {
    plugins: [{ id: pluginId, package: "@fixture/surface", version: "0.0.1", manifest: {
      id: pluginId, name: "Fixture", description: "검사용 표면.", mark: "f", icon: "<path/>",
      surface: { composition: { kind: "view", page: "ui/page.html" } },
    } }],
  });

  // The card elements connect only to declared core commands.
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  try {
    let held = null;
    plane.onLayout((made, draw) => { held = draw; });
    const drawHeld = () => { const draw = held; held = null; draw(); };
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    drawHeld();
    // The first tab is active, so its placeholder is drawn and the tab of the registered plugin is not.
    const tabs = plane.currentGrid().card("main").data.tabs;
    const missingTab = tabs.find((tab) => tab.plugin === missingId).id;
    const where = `surface ${missingTab} placeholder`;
    const text = `${missingId} 플러그인의 설치 상태를 읽지 못했습니다.`;
    assert.equal(plane.currentGrid().card("main").data.activeId, missingTab, "the placeholder tab is not the active tab");
    // The error of the placeholder is shown on its surface once, and the line is written to the application log once.
    assert.equal(document.querySelectorAll(`[data-error="${where}"]`).length, 1, "the unread placeholder did not show exactly one error for its surface");
    assert.deepEqual(reports, [`${where}: ${text}`], "the unread placeholder did not write its error to the application log");
    const shownLine = document.querySelector(`[data-error="${where}"]`);
    assert.equal(shownLine?.textContent, text, "the unread placeholder is not shown on the screen");

    // Closing the placeholder tab removes its surface, so the error of its place is withdrawn.
    await plane.closeTabById(missingTab);
    // The receiver holds the draw of the closing layout until the native preparation finishes, so the test runs it here.
    assert.notEqual(held, null, "closing the tab did not hold a layout draw");
    drawHeld();
    assert.equal(document.querySelector(`[data-error="${where}"]`), null, "closing the surface did not withdraw its error");
    assert.deepEqual(reports, [`${where}: ${text}`], "withdrawing the error wrote it again");
  } finally {
    dom.window.close();
  }
});

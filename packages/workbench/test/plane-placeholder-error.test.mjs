// A tab whose plugin is not loaded opens as a placeholder card (docs/spec/plugins.md#plugins-that-are-not-loaded). The reason unread states a failure
// to read the install state, so its line goes through the one error display path with the surface in its place, and the path withdraws it when the
// surface leaves (F217). The other reasons are ordinary placeholder text and write no error.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { recordsOf, shownRecord } from "./support/records.mjs";

const pluginId = "fixture-placeholder-error";
const missingId = "fixture-not-registered";

test("a placeholder whose install state cannot be read is an error shown once, and withdrawn when its surface leaves", { timeout: 5000 }, async () => {
  // The host calls of the page are answered by the page-wire case (docs/spec/cases/page-wire/README.md). The case is selected before the modules of the page
  // are imported, because host.js reads the host when it is imported. The host answers the read of the install state with the error of an installed.json that is not valid JSON.
  const wire = selectPageWire("plane-placeholder-error");
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/", pretendToBeVisual: true });
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

  // The lines that the error display path writes to the application log reach the host as records of the batches of the call log.
  const reports = () => wire.calls.flatMap(({ name, payload }) => recordsOf(name, payload).map(shownRecord));
  const { flushEvents } = await import("../page-log.js");
  // The read of the plugin state fails, so the placeholder of a tab whose plugin is not loaded has the reason unread.
  const { pluginOperations } = await import("../installed-plugins.js");
  await pluginOperations.refresh();
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
    // The ids of the tabs are drawn from the bytes of this source, which counts, so the lines of the page name the same tabs in every run: the first tab is tab-bbbbbb.
    let draws = 0;
    plane.adopt(plane.fresh((bytes) => bytes.fill(++draws)), "spc-aaaaaa");
    drawHeld();
    // The first tab is active, so its placeholder is drawn and the tab of the registered plugin is not.
    const tabs = plane.currentGrid().card("main").data.tabs;
    const missingTab = tabs.find((tab) => tab.plugin === missingId).id;
    const where = `surface ${missingTab} placeholder`;
    const text = `${missingId} 플러그인의 설치 상태를 읽지 못했습니다.`;
    assert.equal(plane.currentGrid().card("main").data.activeId, missingTab, "the placeholder tab is not the active tab");
    // The error of the placeholder is shown on its surface once, and the line is written to the application log once.
    assert.equal(document.querySelectorAll(`[data-error="${where}"]`).length, 1, "the unread placeholder did not show exactly one error for its surface");
    await flushEvents();
    assert.deepEqual(reports(), [`error workbench ${where}: ${text}`], "the unread placeholder did not write its error to the application log");
    const shownLine = document.querySelector(`[data-error="${where}"]`);
    assert.equal(shownLine?.textContent, text, "the unread placeholder is not shown on the screen");

    // Closing the placeholder tab removes its surface, so the error of its place is withdrawn.
    await plane.closeTabById(missingTab);
    // The receiver holds the draw of the closing layout until the native preparation finishes, so the test runs it here.
    assert.notEqual(held, null, "closing the tab did not hold a layout draw");
    drawHeld();
    assert.equal(document.querySelector(`[data-error="${where}"]`), null, "closing the surface did not withdraw its error");
    await flushEvents();
    assert.deepEqual(reports(), [`error workbench ${where}: ${text}`], "withdrawing the error wrote it again");
    dom.window.close();
    await new Promise((resolve) => setImmediate(resolve));
    await flushEvents();
    wire.finish();
  } finally {
    dom.window.close();
  }
});

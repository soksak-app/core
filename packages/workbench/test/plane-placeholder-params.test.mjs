// A stored tab whose params do not match the declaration of its loaded plugin opens as a placeholder (docs/spec/plugins.md#pluginjson). The mismatch
// is a failure of the stored data, so its line goes through the one error display path with the place of its surface, and the path withdraws it when
// the surface leaves (F217). The text names the plugin, its version and the mismatch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { recordsOf, shownRecord } from "./support/records.mjs";

const pluginId = "fixture-placeholder-params";
const version = "0.0.1";

test("a stored tab whose params do not match its plugin is an error shown once, and withdrawn when its surface leaves", { timeout: 5000 }, async () => {
  // The host calls of the page are answered by the page-wire case (docs/spec/cases/page-wire/README.md). The case is selected before the modules of the page
  // are imported, because host.js reads the host when it is imported.
  const wire = selectPageWire("plane-placeholder-params");
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
  // The environment of the page: the card holds a tab whose stored params do not match the declaration, and a tab whose params match it.
  const mismatched = { path: 5 };
  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [
        { plugin: pluginId, title: "bad" },
        { plugin: pluginId, title: "good" },
      ] }],
    } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [{ id: pluginId, package: "@fixture/placeholder-params", version, manifest: {
    id: pluginId, name: "Fixture", description: "검사용 표면.", mark: "f", icon: "<path/>",
    surface: {
      composition: { kind: "view", page: "ui/index.html" },
      params: { type: "object", properties: { path: { type: "string" } } },
      opens: { extensions: ["txt"] },
    },
  } }] }), [], "the fixture environment refused a plugin");

  // The card elements connect only to declared core commands.
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  try {
    let held = null;
    plane.onLayout((made, draw) => { held = draw; });
    const drawHeld = () => { const draw = held; held = null; draw(); };
    // A saved space keeps the params of its tabs. The environment layout starts tabs without params, so the test stores them in the saved state.
    // The ids of the tabs are drawn from the bytes of this source, which counts, so the lines of the page name the same tabs in every run: the first tab is tab-bbbbbb.
    let draws = 0;
    const kept = plane.fresh((bytes) => bytes.fill(++draws));
    for (const tab of kept.state.cards.find((card) => card.id === "main").data.tabs) {
      tab.params = tab.title === "bad" ? mismatched : { path: "ok" };
    }
    plane.adopt(kept, "spc-aaaaaa");
    drawHeld();
    // The first tab is active, so its placeholder is drawn. The stored params of the tab are kept as they were stored.
    const tabs = plane.currentGrid().card("main").data.tabs;
    const badTab = tabs.find((tab) => tab.title === "bad");
    assert.deepEqual(badTab.params, mismatched, "the stored params of the placeholder tab were not kept");
    assert.equal(plane.currentGrid().card("main").data.activeId, badTab.id, "the placeholder tab is not the active tab");
    const where = `surface ${badTab.id} placeholder`;
    const text = `${pluginId} ${version} 탭의 인자가 선언과 맞지 않습니다: params do not match ${pluginId} surface.params`;
    assert.equal(document.querySelectorAll(`[data-error="${where}"]`).length, 1, "the mismatched params did not show exactly one error for their surface");
    assert.equal(document.querySelector(`[data-error="${where}"]`).textContent, text, "the mismatched params did not show their text");
    await flushEvents();
    assert.deepEqual(reports(), [`error workbench ${where}: ${text}`], "the mismatched params did not write their error to the application log");

    // Closing the placeholder tab removes its surface, so the error of its place is withdrawn.
    await plane.closeTabById(badTab.id);
    assert.notEqual(held, null, "closing the tab did not hold a layout draw");
    drawHeld();
    assert.equal(document.querySelector(`[data-error="${where}"]`), null, "closing the surface did not withdraw its error");
    await flushEvents();
    assert.equal(reports().length, 1, "withdrawing the error wrote it again");

    const { surfaceForTab, viewStartValues } = await import("../surface-modules.js");
    const opened = plane.openFile("sample.txt");
    assert.equal(opened.tab, plane.currentGrid().card("main").data.activeId);
    assert.deepEqual(plane.currentGrid().card("main").data.tabs.find(({ id }) => id === opened.tab).params, { path: "sample.txt" });
    assert.notEqual(held, null, "opening the file did not schedule a layout draw");
    drawHeld();
    const surface = surfaceForTab(plane.currentGrid().card("main").data.tabs.find(({ id }) => id === opened.tab));
    assert.equal(surface.composition.kind, "view", "core.file.open did not produce a view surface");
    assert.deepEqual(surface.params, { path: "sample.txt" }, "the surface of the tab did not receive the tab params");
    assert.deepEqual(viewStartValues(surface, { id: "prj-open", root: "/work/project" }).params, { path: "sample.txt" },
      "the producer start values did not preserve the file-open path");
    dom.window.close();
    await new Promise((resolve) => setImmediate(resolve));
    await flushEvents();
    wire.finish();
  } finally {
    dom.window.close();
  }
});

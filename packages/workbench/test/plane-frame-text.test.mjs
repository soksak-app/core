// The prepared layout draws a change of the frame scale. The preparation holds the height of the first row that the next drawing will show, and the scale is
// applied to the document in that drawing. This way the title bar and the row that the host sets in the same transaction appear in the same frame
// (docs/spec/native-surfaces.md#title-bar-height).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { HostWorkspaceStore } from "../host-store.js";
import { recordsOf, shownRecord } from "./support/records.mjs";

const pluginId = "fixture-frame-text";

test("a frame factor change prepares the row of the next draw and writes the factor in that draw", { timeout: 5000 }, async () => {
  // The host calls of the page are answered by the page-wire case (docs/spec/cases/page-wire/README.md). The case is selected before the modules of the page
  // are imported, because host.js reads the host when it is imported.
  const wire = selectPageWire("plane-frame-text");
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/", pretendToBeVisual: true });
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
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  // The environment and the plugin are installed through the environment module, as the page installs them at its start.
  const { installEnvironment } = await import("../environment.js");
  installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "main" }] }],
    } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [{ id: pluginId, package: `@fixture/${pluginId}`, version: "0.0.1", manifest: {
    id: pluginId, name: "Fixture", description: "검사용 표면.", mark: "f", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/page.html" } },
  } }] });
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);

  const settings = await import("../settings.js");
  await settings.connectSettings(new HostWorkspaceStore(host));
  const plane = await import("../plane.js");
  const compositor = await import("../compositor.js");
  const { flushEvents } = await import("../page-log.js");
  const records = [];
  compositor.onCommit((record) => { records.push(record); });
  const root = document.documentElement;
  const drawnFactor = () => root.style.getPropertyValue("--frame-text");
  try {
    // The first drawing is not prepared (same as index.html).
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    let held = null;
    plane.onLayout((made, draw, seated, titlebar) => { held = { made, draw, seated, titlebar }; });
    const before = drawnFactor();

    // What index.html does on a settings change: it measures the plane size again and draws.
    await settings.set({ textSize: 1.5 }, "common", "test");
    plane.setGap(settings.halfGap());
    plane.settle();
    assert.ok(held, "the factor change did not reach the layout receiver");
    assert.equal(held.titlebar, 54, "the preparation carries the 54px row that the draw at factor 1.5 shows");
    assert.equal(drawnFactor(), before, "the factor reached the document before the prepared draw");
    // Verify V7c judges the prediction on the grid of its layout, which the display can leave before the check.
    assert.deepEqual([...held.seated.values()].map((seat) => seat.grid), [globalThis.devicePixelRatio],
      "the seats of the layout do not carry the device pixel scale that the view laid the cards out on");

    records.length = 0;
    compositor.publishAhead(held.made, held.seated, held.titlebar);
    assert.equal(records.at(-1).titlebar, 54, "the preparation record carries the row of the next draw");
    held.draw();
    assert.equal(drawnFactor(), "1.5", "the prepared draw writes the factor");
    // A section is in no card: a view of a drawn section reads the frame factor, as the mygo workbench answers it.
    const { showSectionSurface, hideSectionSurface } = await import("../section-surfaces.js");
    const { surfaceTextSize } = await import("../text-size.js");
    const section = "spc-aaaaaa/left/files.tree";
    assert.equal(surfaceTextSize(section), null, "a section that no sidebar draws has no scale");
    showSectionSurface(section);
    assert.equal(surfaceTextSize(section), 1.5, "a drawn section reads the frame factor");
    hideSectionSurface(section);
    assert.equal(surfaceTextSize(section), null, "a section that the sidebar left keeps the last scale of its view");
    compositor.publish();
    assert.equal(records.at(-1).drawn, true);
    assert.equal(records.at(-1).titlebar, 54, "the record after the draw carries the drawn row");

    // Lowering the scale shrinks the row. The reply of the window does not set the row.
    held = null;
    await settings.set({ textSize: 1 }, "common", "test");
    plane.setGap(settings.halfGap());
    plane.settle();
    assert.equal(held.titlebar, 40);
    assert.equal(drawnFactor(), "1.5", "the smaller factor reached the document before the prepared draw");
    held.draw();
    assert.equal(drawnFactor(), "1");
    // The window closes here: the focus leaves the document, and the events that the gate refused are reported in the batch of the flush.
    dom.window.close();
    await new Promise((resolve) => setImmediate(resolve));
    await flushEvents();
    assert.deepEqual(wire.calls.flatMap(({ name, payload }) => recordsOf(name, payload).map(shownRecord)), [], "the page reported an error");
    wire.finish();
  } finally {
    dom.window.close();
  }
});

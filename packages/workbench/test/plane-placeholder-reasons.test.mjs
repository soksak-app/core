// The placeholder reasons missing, disabled, reload and host describe designed states of a saved layout that names a plugin that is not loaded
// (docs/spec/plugins.md#plugins-that-are-not-loaded). They are not failures, so they write no error through the error display path (F217).
// This test is a regression guard: the reason unread is the only one that shows an error, and it is tested in plane-placeholder-error.test.mjs. The reason
// host is a page without a host, which plane-placeholder-host.test.mjs draws.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { recordsOf, shownRecord } from "./support/records.mjs";

const pluginId = "fixture-placeholder-reasons";

test("the placeholder reasons that the host state gives write no error", { timeout: 5000 }, async () => {
  // The host calls of the page are answered by the page-wire case (docs/spec/cases/page-wire/README.md). The case is selected before the modules of the page
  // are imported, because host.js reads the host when it is imported.
  const wire = selectPageWire("plane-placeholder-reasons");
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

  // The plugin state that each reason reads is the answer of the host to the read of the plugin state. The read tells the listeners that the plane registered for plugin changes.
  const { pluginOperations } = await import("../installed-plugins.js");
  const { flushEvents } = await import("../page-log.js");
  // The environment of the page: one tab of a plugin that is not installed in the environment, so the plugin is not loaded.
  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "gone" }] }],
    } },
  }, { plugins: [] }), [], "the fixture environment refused a plugin");

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
    // The host answers the three reads in this order: the plugin is not installed, it is installed disabled, and it is installed enabled but not loaded.
    for (const reason of ["missing", "disabled", "reload"]) {
      await pluginOperations.refresh();
      drawHeld();
      const line = document.querySelector(`[data-plugin-placeholder="${reason}"] p`);
      assert.ok(line?.textContent, `the ${reason} placeholder is not drawn`);
      assert.equal(line.dataset.error, undefined, `the ${reason} placeholder is marked as an error`);
      assert.equal(document.querySelector("[data-error]"), null, `the ${reason} placeholder reached the error display path`);
    }
    // The error display path writes every error it shows to the application log, so an error record in the batches of the page is a placeholder that showed an error.
    await flushEvents();
    assert.deepEqual(wire.calls.flatMap(({ name, payload }) => recordsOf(name, payload).map(shownRecord)), [], "a designed placeholder reason wrote an error to the application log");
    dom.window.close();
    await new Promise((resolve) => setImmediate(resolve));
    await flushEvents();
    wire.finish();
  } finally {
    dom.window.close();
  }
});

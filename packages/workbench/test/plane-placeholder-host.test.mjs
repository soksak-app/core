// The placeholder reason host is the designed state of a page without a host: a saved layout names a plugin, and the page cannot install it
// (docs/spec/plugins.md#plugins-that-are-not-loaded). It is not a failure, so it writes no error through the error display path (F217). The page of this test
// has no host, so it writes its application log to the console, which the test reads. The reasons that a host state gives are tested in
// plane-placeholder-reasons.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const pluginId = "fixture-placeholder-host";

test("the placeholder reason host of a page without a host writes no error", { timeout: 5000 }, async () => {
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
  // A page without a host writes an error to the console as an error line, which this test collects.
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(line);
  try {
    let held = null;
    plane.onLayout((made, draw) => { held = draw; });
    const drawHeld = () => { const draw = held; held = null; draw(); };
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    drawHeld();
    const line = document.querySelector('[data-plugin-placeholder="host"] p');
    assert.ok(line?.textContent, "the host placeholder is not drawn");
    assert.equal(line.dataset.error, undefined, "the host placeholder is marked as an error");
    assert.equal(document.querySelector("[data-error]"), null, "the host placeholder reached the error display path");
    assert.deepEqual(lines, [], "the host placeholder wrote an error to the application log");
  } finally {
    console.error = original;
    dom.window.close();
  }
});

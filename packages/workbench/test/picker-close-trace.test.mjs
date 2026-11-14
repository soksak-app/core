// Closing the native picker writes the page trace event `workbench.trace.picker.close` with the reason of the close
// (docs/spec/performance-trace.md#producers). The host calls of the page are answered by the page-wire case of this test
// (docs/spec/cases/page-wire/README.md). The case is selected before the modules that read the host are imported.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

// The page of the window is drawn in this document, which the modules read when they are imported.
const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const dom = new JSDOM(markup, { url: "http://localhost/" });
dom.window.matchMedia = (query) => ({ media: query, matches: true,
  addEventListener: () => {}, removeEventListener: () => {} });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// jsdom has no adoptedStyleSheets, which the page reads when a style sheet exists; no sheet is adopted here.
dom.window.document.adoptedStyleSheets = [];
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
// The native picker is drawn as a menu view whose border and background are read from the inline styles of its element.
const pickerEl = document.getElementById("picker");
pickerEl.style.borderTopColor = "rgb(7, 8, 9)";
pickerEl.style.backgroundColor = "rgb(255, 255, 255)";
pickerEl.style.borderTopLeftRadius = "4px";

const wire = selectPageWire("picker-close-trace-dismiss");
const { installEnvironment } = await import("../environment.js");
const { registry } = await import("../exposure.js");
const { setLogPolicy } = await import("../log-policy.js");
const { setTraceEnabled } = await import("../performance.js");
const { flushEvents } = await import("../page-log.js");
const { orderedCallsAnswered } = await import("../host.js");
const plane = await import("../plane.js");

test("closing the picker writes picker.close with the reason of the close", { timeout: 5000 }, async () => {
  try {
    // The trace event is of the class call, which the policy stores at the level debug, and the trace is on only after its switch.
    await setLogPolicy({ call: "debug" });
    await setTraceEnabled(true);
    // The tab's plugin is not installed, so the tab is drawn as a placeholder and no surface is mounted.
    const installErrors = installEnvironment({
      runtime: "runtime",
      workspace: { focus: "main", grid: {
        xs: [0, 1], ys: [0, 1],
        cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "fixture-picker-close", title: "main" }] }],
      } },
      sidebars: { sets: [], links: [] },
    }, { plugins: [] });
    assert.deepEqual(installErrors, [], "the environment of the case is not loaded");
    registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
    let held = null;
    plane.onLayout((made, draw) => { held = { made, draw }; });
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    held.draw();
    plane.openCardTabs("main");
    assert.equal(plane.pickerState().open, true, "the tab list of the card did not open");
    // The layer is shown by the turn of the host calls. The close waits for the end of that turn, so the hide follows the show.
    await orderedCallsAnswered();
    plane.closePicker("dismiss");
    await orderedCallsAnswered();
    // The events of the trace and the counts of the log gate leave in the batch of the flush, so no batch is left for a timer.
    await flushEvents();
    const events = wire.calls.filter((call) => call.name === "log" && call.payload?.action === "batch")
      .flatMap((call) => call.payload.events);
    assert.deepEqual(events.filter((event) => event.event === "workbench.trace.picker.close").map((event) => event.fields),
      [{ reason: "dismiss" }]);
    assert.deepEqual(events.filter((event) => event.level === "error"), [], "the page wrote an error record");
    wire.finish();
  } finally {
    dom.window.close();
  }
});

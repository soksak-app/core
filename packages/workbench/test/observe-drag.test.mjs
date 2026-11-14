// The page answers the point of a boundary for a drag that the host delivers as native input (diagnostics.drag with
// native: true in docs/spec/endpoint.md), and its own drag presses at the same point.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

// observe.js registers its listener of diagnostics-tick once, when it is imported, so the three tests share one case: its notices are
// the steps of the drags in the order of the tests.
const wire = selectPageWire("observe-drag-ticks");
// The plane module binds the elements of the workbench document when it is imported, so the document is the one of index.html.
const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/", pretendToBeVisual: true });
dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.devicePixelRatio = dom.window.devicePixelRatio;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.CSS = dom.window.CSS;
globalThis.PointerEvent = dom.window.PointerEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
// JSDOM has no ResizeObserver, so the view of the plane reports its observation as unavailable at its animation frame
// (SoksakView.observesHost) and this document, which has no layout, delivers none.
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
const planeElement = document.getElementById("plane");
Object.defineProperty(planeElement, "clientWidth", { value: 800 });
Object.defineProperty(planeElement, "clientHeight", { value: 600 });
const border = document.createElement("style");
border.textContent = ".card { --bw: 1px; --divider: 1px; }";
document.head.appendChild(border);

// The workspace has two cards side by side, so its plane draws one boundary on the axis x.
const { installEnvironment } = await import("../environment.js");
installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: {
    xs: [0, 0.5, 1], ys: [0, 1],
    cards: [
      { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "fixture-drag", title: "left" }] },
      { id: "second", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [{ plugin: "fixture-drag", title: "right" }] },
    ],
  } },
  sidebars: { sets: [], links: [] },
}, { plugins: [{ id: "fixture-drag", package: "@scope/fixture-drag", version: "0.0.1", manifest: {
  id: "fixture-drag", name: "Drag", description: "검사용 표면.", mark: "d", icon: "<path/>",
  surface: { composition: { kind: "view", page: "ui/index.html" } },
} }] });
const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const plane = await import("../plane.js");
plane.onLayout((made, draw) => draw());
plane.adopt(plane.fresh(), "spc-aaaaaa");
const divider = document.querySelector(".sp-divider[data-axis=\"x\"]");
const line = Number(divider.dataset.line);
// JSDOM has no layout, so the rectangle of the divider is given to the element as its layout, and a point is on the element that
// contains it.
divider.getBoundingClientRect = () => ({ left: 100, top: 40, width: 10, height: 300 });
document.elementFromPoint = (x, y) => (x >= 100 && x <= 110 && y >= 40 && y <= 340 ? divider : null);
// The input that the plane receives, as the mouse events of the document that its drag handles.
const inputs = [];
for (const [type, phase] of [["mousedown", 0], ["mousemove", 1], ["mouseup", 2]]) {
  document.addEventListener(type, (event) => inputs.push({ phase, x: event.clientX, y: event.clientY }), true);
}
await import("../observe.js");
const { flushEvents } = await import("../page-log.js");

test("diagnostics.drag.boundary answers the centre of the named boundary and its absence", async () => {
  assert.deepEqual(await registry.handle({ id: 1, method: "diagnostics.drag.boundary", params: { axis: "x", line } }), { result: { x: 105, y: 190 } });
  const absent = await registry.handle({ id: 2, method: "diagnostics.drag.boundary", params: { axis: "y", line: 2 } });
  assert.equal(absent.error?.message, "no y boundary at line 2");
});

test("the page drag presses at the point that diagnostics.drag.boundary answers", async () => {
  const from = (await registry.handle({ id: 3, method: "diagnostics.drag.boundary", params: { axis: "x", line } })).result;
  inputs.length = 0;
  const drag = registry.handle({ id: 4, method: "diagnostics.drag", params: { axis: "x", line, dx: 20, dy: 0, ms: 16, times: 1 } });
  // One leg out and one leg back, each ended by a host tick that is marked last.
  wire.deliverNotice();
  wire.deliverNotice();
  const { result } = await drag;
  assert.deepEqual(result.from, from);
  assert.equal(result.steps, 2, "each leg ends at the step that the host marks last");
  assert.equal(result.asked, 32, "asked is times × 2 × ms");
  assert.deepEqual(inputs[0], { phase: 0, ...from });
  assert.deepEqual(inputs.at(-1), { phase: 2, ...from });
});

test("a host tick that reports a step it could not pace rejects the page drag", async () => {
  inputs.length = 0;
  const drag = registry.handle({ id: 5, method: "diagnostics.drag", params: { axis: "x", line, dx: 20, dy: 0, ms: 16, times: 1 } });
  wire.deliverNotice();
  // The drag ends only by its rejection, so the rejection is the event that the check waits for.
  const { error } = await drag;
  assert.equal(error?.message, "the window is on no display with a refresh rate");
  await flushEvents();
  wire.finish();
});

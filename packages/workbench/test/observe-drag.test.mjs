// The page answers the point of a boundary for a drag that the host delivers as native input (diagnostics.drag with
// native: true in docs/spec/endpoint.md), and its own drag presses at the same point.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

// observe.js registers its listener of diagnostics-tick once, when it is imported, so the three tests share one case: its notices are
// the steps of the drags in the order of the tests.
const wire = selectPageWire("observe-drag-ticks");
const dom = new JSDOM('<body><div id="plane"></div><div class="sp-divider" data-axis="x" data-line="3"></div></body>', { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// JSDOM has no layout, so the rectangle of the divider is given to the element as its layout.
document.querySelector('.sp-divider[data-axis="x"][data-line="3"]').getBoundingClientRect = () => ({ left: 100, top: 40, width: 10, height: 300 });

const inputs = [];
// The modules below stay replaced. The plane has a grid only in a window, so the drag reads its boundary positions and input from this
// replacement. The surface modules present native surfaces, which this file does not use, and resize-loop installs the observer of the
// ResizeObserver loop error of WebKit, which the JSDOM document does not raise.
mock.module("../surface-modules.js", { exports: { mountedSurface: () => null } });
mock.module("../resize-loop.js", { exports: { watchResizeLoop: () => {} } });
mock.module("../plane.js", { exports: {
  currentGrid: () => ({ boundaryPos: () => 0 }),
  surfaceInput: (input) => inputs.push(input),
} });
await import("../observe.js");
const { registry } = await import("../exposure.js");

test("diagnostics.drag.boundary answers the centre of the named boundary and its absence", async () => {
  assert.deepEqual(await registry.handle({ id: 1, method: "diagnostics.drag.boundary", params: { axis: "x", line: 3 } }), { result: { x: 105, y: 190 } });
  const absent = await registry.handle({ id: 2, method: "diagnostics.drag.boundary", params: { axis: "y", line: 2 } });
  assert.equal(absent.error?.message, "no y boundary at line 2");
});

test("the page drag presses at the point that diagnostics.drag.boundary answers", async () => {
  const from = (await registry.handle({ id: 3, method: "diagnostics.drag.boundary", params: { axis: "x", line: 3 } })).result;
  inputs.length = 0;
  const drag = registry.handle({ id: 4, method: "diagnostics.drag", params: { axis: "x", line: 3, dx: 20, dy: 0, ms: 16, times: 1 } });
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
  const drag = registry.handle({ id: 5, method: "diagnostics.drag", params: { axis: "x", line: 3, dx: 20, dy: 0, ms: 16, times: 1 } });
  wire.deliverNotice();
  // The drag ends only by its rejection, so the rejection is the event that the check waits for.
  const { error } = await drag;
  assert.equal(error?.message, "the window is on no display with a refresh rate");
  wire.finish();
});

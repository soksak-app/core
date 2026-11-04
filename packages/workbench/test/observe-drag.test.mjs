// The page answers the point of a boundary for a drag that the host delivers as native input (diagnostics.drag with
// native: true in docs/spec/endpoint.md), and its own drag presses at the same point.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const methods = new Map();
const hostEvents = new Map();
const inputs = [];
mock.module("../exposure.js", { exports: {
  registry: { method: (name, handler) => methods.set(name, handler) },
  gateSurfaceReplies: () => {},
} });
mock.module("../host.js", { exports: { log: () => {}, native: false, watchCalls: () => {} } });
mock.module("../page-log.js", { exports: { emitEvent: () => {} } });
mock.module("../page-identity.js", { exports: { pageIdentity: "page-fixture" } });
mock.module("../transcript.js", { exports: {
  createTranscript: () => ({ set: () => {}, record: () => {} }), transcriptSender: () => () => {},
} });
mock.module("../surface-reply-hold.js", { exports: {
  createSurfaceReplyHold: () => ({ gate: () => {}, closed: () => {}, hold: () => {}, held: async () => {} }),
} });
mock.module("../surface-modules.js", { exports: { mountedSurface: () => null } });
mock.module("../resize-loop.js", { exports: { watchResizeLoop: () => {} } });
mock.module("../page-layout.js", { exports: { armLayoutFault: () => {} } });
mock.module("../plane.js", { exports: {
  currentGrid: () => ({ boundaryPos: () => 0 }),
  surfaceInput: (input) => inputs.push(input),
} });
mock.module("@soksak/runtime", { exports: { host: { on: (name, handler) => hostEvents.set(name, handler), call: async () => null } } });

const selectors = [];
globalThis.document = {
  querySelector: (selector) => {
    selectors.push(selector);
    if (selector !== '.sp-divider[data-axis="x"][data-line="3"]') return null;
    return { getBoundingClientRect: () => ({ left: 100, top: 40, width: 10, height: 300 }) };
  },
};
await import("../observe.js");

test("diagnostics.drag.boundary answers the centre of the named boundary and its absence", () => {
  const boundary = methods.get("diagnostics.drag.boundary");
  assert.equal(typeof boundary, "function", "the page registers no diagnostics.drag.boundary");
  assert.deepEqual(boundary({ axis: "x", line: 3 }), { x: 105, y: 190 });
  assert.equal(selectors.at(-1), '.sp-divider[data-axis="x"][data-line="3"]');
  assert.throws(() => boundary({ axis: "y", line: 2 }), { message: "no y boundary at line 2" });
});

test("the page drag presses at the point that diagnostics.drag.boundary answers", async () => {
  const boundary = methods.get("diagnostics.drag.boundary");
  assert.equal(typeof boundary, "function", "the page registers no diagnostics.drag.boundary");
  inputs.length = 0;
  const drag = methods.get("diagnostics.drag")({ axis: "x", line: 3, dx: 20, dy: 0, ms: 16, times: 1 });
  // One step out and one step back, each on a host tick.
  hostEvents.get("diagnostics-tick")();
  hostEvents.get("diagnostics-tick")();
  const result = await drag;
  const from = boundary({ axis: "x", line: 3 });
  assert.deepEqual(result.from, from);
  assert.deepEqual(inputs[0], { phase: 0, ...from });
  assert.deepEqual(inputs.at(-1), { phase: 2, ...from });
});

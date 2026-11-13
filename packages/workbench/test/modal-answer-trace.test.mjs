// The answer of a native modal that the page receives is written as the page trace event `workbench.trace.modal.answer` with its key, at
// the receipt (docs/spec/performance-trace.md#producers). The overlay document has no trace switch, so the main page writes the event.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const dom = new JSDOM('<body><div id="plane"></div><div id="menu" data-native-modal="menu" aria-label="Menu" style="border-top-color: rgb(7, 8, 9); background-color: rgb(10, 11, 12); border-top-left-radius: 4px"></div></body>', { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

// The trace events that the page relayed to the host in its log batches, as {event, fields} with the prefix workbench.trace. removed.
const traceOf = (wire) => wire.calls
  .filter(({ name, payload }) => name === "log" && payload.action === "batch")
  .flatMap(({ payload }) => payload.events)
  .filter(({ event }) => event.startsWith("workbench.trace."))
  .map(({ event, fields }) => ({ event: event.slice("workbench.trace.".length), fields }));

test("an answer that reaches the receiver of a modal is traced as modal.answer with its key", async () => {
  // The case selects the host of the page before the modules that read it are imported, because the page reads the host when it is imported.
  const wire = selectPageWire("modal-answer-trace-answer");
  const { logGate } = await import("../log-gate.js");
  // The trace event is stored at the level debug of the class call, so the gate stores that class at trace.
  logGate.set({ lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" });
  const { setTraceEnabled } = await import("../performance.js");
  const { flushEvents } = await import("../page-log.js");
  const { overlay, orderedCallsAnswered } = await import("../host.js");
  await setTraceEnabled(true);
  const el = document.getElementById("menu");
  const picked = [];
  overlay.show(el, { x: 0, y: 0, w: 10, h: 10 }, (key, value) => picked.push([key, value]));
  await orderedCallsAnswered();
  wire.deliverNotice();
  assert.deepEqual(picked, [["core.modal.dismiss", ""]]);
  await flushEvents();
  assert.deepEqual(traceOf(wire), [{ event: "modal.answer", fields: { key: "core.modal.dismiss" } }]);
  wire.finish();
});

test("a state report of the modal document is not an answer and is not traced", async () => {
  const wire = selectPageWire("modal-answer-trace-document");
  // A second instance of the host module registers its listeners on the host of this case.
  const { overlay, orderedCallsAnswered } = await import("../host.js?modal-answer-trace-document");
  const { flushEvents } = await import("../page-log.js");
  const el = document.getElementById("menu");
  overlay.show(el, { x: 0, y: 0, w: 10, h: 10 }, () => {});
  await orderedCallsAnswered();
  wire.deliverNotice();
  await flushEvents();
  assert.deepEqual(traceOf(wire), []);
  wire.finish();
});

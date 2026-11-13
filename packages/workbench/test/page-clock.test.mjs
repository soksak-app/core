// The clock statement of a document (docs/spec/logging.md#writers): the main page states workbench.log.clock once, in its first
// batch, whichever writer of the page queued the first event; the records of the page and the events of its trace leave
// through one writer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPageWire } from "@soksak/runtime";

// The host calls of the page are answered by the case of this test; it is selected before the page log is imported, because the page reads the host when it is imported.
const wire = selectPageWire("page-clock-statement");
const { emitEvent, flushEvents } = await import("../page-log.js");
const { setTraceEnabled, trace } = await import("../performance.js");
const { logGate } = await import("../log-gate.js");
logGate.set({ lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" });

test("the main page states its clock once for the events of its records and of its trace", async () => {
  await setTraceEnabled(true);
  emitEvent("info", "workbench.start", { started_at: 1, url: "wails://localhost/" });
  trace("surface.mount", { plugin: "probe", surface: "tab-a", ms: 1 });
  await flushEvents();
  await flushEvents();
  await setTraceEnabled(false);
  const events = wire.calls
    .filter(({ name, payload }) => name === "log" && payload.action === "batch")
    .flatMap(({ payload }) => payload.events);
  const clocks = events.filter((event) => event.event === "workbench.log.clock");
  assert.equal(clocks.length, 1, `the page stated its clock ${clocks.length} times: ${JSON.stringify(events.map((event) => event.event))}`);
  assert.deepEqual(events.filter((event) => event.event !== "workbench.log.clock").map((event) => event.event),
    ["workbench.start", "workbench.trace.surface.mount"], "the records and the trace leave in the order the page queued them");
  wire.finish();
});

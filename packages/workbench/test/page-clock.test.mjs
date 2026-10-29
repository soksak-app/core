// The clock statement of a document (docs/spec/logging.md#writers): the main page states page.log.clock once, in its first
// batch, whichever writer of the page queued the first event; the records of the page and the events of its trace leave
// through one writer.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { clockAnswer, settled } from "./support/records.mjs";

const batches = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, request) => {
    const clock = clockAnswer(name, request);
    if (clock) return clock;
    if (name === "log" && request.action === "batch") batches.push(request.events);
    return null;
  },
} } });
const { emitEvent, flushEvents } = await import("../page-log.js");
const { setTraceEnabled, trace } = await import("../performance.js");
const { logGate } = await import("../log-gate.js");
logGate.set({ lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" });

test("the main page states its clock once for the events of its records and of its trace", async () => {
  await setTraceEnabled(true);
  emitEvent("info", "page.start", { time_origin: 1, url: "wails://localhost/" });
  trace("surface.mount", { plugin: "probe", surface: "tab-a", ms: 1 });
  await settled();
  await flushEvents();
  await setTraceEnabled(false);
  const events = batches.flat();
  const clocks = events.filter((event) => event.event === "page.log.clock");
  assert.equal(clocks.length, 1, `the page stated its clock ${clocks.length} times: ${JSON.stringify(events.map((event) => event.event))}`);
  assert.deepEqual(events.filter((event) => event.event !== "page.log.clock").map((event) => event.event),
    ["page.start", "page.trace.surface.mount"], "the records and the trace leave in the order the page queued them");
});

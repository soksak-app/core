// The report of the counts of the gate leaves when the clock of the page reaches the interval, whatever time the code takes
// (docs/spec/logging.md#policy). The test runtime gives the page a clock that stays at 0 until the test advances it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clock, selectPageWire } from "@soksak/runtime";

const wire = selectPageWire("page-log-gated-clock");
const { reportRecord, emitEvent } = await import("../page-log.js");
const { logGate } = await import("../log-gate.js");
logGate.set({ lifecycle: "trace", input: "trace", call: "warn", io: "trace", frame: "trace" });

const batches = () => wire.calls.filter(({ name, payload }) => name === "log" && payload.action === "batch");
const gatedIn = (calls) => calls.flatMap(({ payload }) => payload.events).filter(({ event }) => event === "workbench.log.gated");

test("a count that the gate refused waits for the clock of the page, not for the run time of the code", { timeout: 10000 }, async () => {
  emitEvent("debug", "workbench.call", { name: "a" });
  // The one real wait of this test: the defect depends on real time passing beyond the interval while the clock of the page has not
  // moved, so the time is the input and not a judge of the result.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  emitEvent("debug", "workbench.call", { name: "b" });
  await reportRecord("error", "gated clock: first");
  assert.equal(gatedIn(batches()).length, 0, "a count left although the clock of the page did not reach the interval");
  clock.advance(1000);
  while (batches().length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(gatedIn(batches()).map(({ fields }) => fields), [{ class: "call", level: "debug", count: 2 }]);
  wire.finish();
});

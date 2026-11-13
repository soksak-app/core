// The records that the page sends to the host: a failure has the level error and an observation the level info, and a line
// `<where>: <text>` is split at its first `: ` (docs/spec/diagnostics.md#forms). A window check finds the errors of a check by
// the level.
import assert from "node:assert/strict";
import test from "node:test";
import { selectPageWire } from "@soksak/runtime";
import { recordsOf, shownRecord } from "./support/records.mjs";

// The case of the first test is selected before host.js is imported, because the page reads the host wire when its modules are imported.
const first = selectPageWire("report-levels-records");
const { log, report, surfaceContextRuntime } = await import("../host.js");
const { connectExposure, registry, revisitRegistrations } = await import("../exposure.js");
const { flushEvents } = await import("../page-log.js");
const { logGate } = await import("../log-gate.js");
// The events below the level error are stored only in the debug state (docs/spec/settings.md, the section of core.settings.debug), which these tests
// examine, so the state of every class at trace is set here.
logGate.set({ lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" });

// The lines `<level> workbench <where>: <text>` of the records that the page sent in the calls of the wire, in order.
const linesOf = (wire) => wire.calls.flatMap((call) => recordsOf(call.name, call.payload)).map(shownRecord);

test("a reported failure has the level error and an observation has the level info", async () => {
  await report("surface probe mount failed: x");
  await log("focus moved to probe");
  await flushEvents();
  assert.deepEqual(linesOf(first), ["error workbench surface probe mount failed: x", "info workbench workbench: focus moved to probe"]);
  first.finish();
});

test("a surface module reports its failure as an error line", async () => {
  const wire = selectPageWire("report-levels-surface");
  const runtime = surfaceContextRuntime({ surfaceId: "probe-1" });
  await runtime.native.call("report", "surface composition failed: probe");
  await flushEvents();
  assert.deepEqual(linesOf(wire), ["error workbench surface composition failed: probe"]);
  wire.finish();
});

test("a failed settling wait of a core command and a refused registration are error lines", async () => {
  const wire = selectPageWire("report-levels-exposure");
  registry.declare("core", { status: [], element: [], commands: [{
    name: "core.fixture.add", description: "Adds.",
    params: { type: "object", properties: { n: { type: "integer" } } }, result: { type: "integer" },
  }] });
  registry.command("core.fixture.add", ({ n }) => n + 1);
  await connectExposure({
    settled: async () => { throw new Error("surface tab-1 is not mounted"); },
    report,
  });
  assert.equal(await registry.run("core.fixture.add", { n: 1 }), 2);
  await flushEvents();
  assert.deepEqual(linesOf(wire), ["error workbench exposure settled failed: surface tab-1 is not mounted"]);
  assert.throws(() => revisitRegistrations(), /requires report/);
  wire.finish();
});

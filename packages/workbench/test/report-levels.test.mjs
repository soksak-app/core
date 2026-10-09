// The records that the page sends to the host: a failure has the level error and an observation the level info, and a line
// `<where>: <text>` is split at its first `: ` (docs/spec/diagnostics.md#forms). A window check finds the errors of a check by
// the level.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const shown = (record) => `${record.level} page ${record.where}: ${record.text}`;
const lines = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, payload) => {
    if (name === "report") lines.push(shown(payload));
  },
} } });
const { log, report, surfaceContextRuntime } = await import("../host.js");

test("a reported failure has the level error and an observation has the level info", async () => {
  lines.length = 0;
  await report("surface probe mount failed: x");
  await log("focus moved to probe");
  assert.deepEqual(lines.splice(0), ["error page surface probe mount failed: x", "info page page: focus moved to probe"]);
});

test("a surface module reports its failure as an error line", async () => {
  lines.length = 0;
  const runtime = surfaceContextRuntime({ surfaceId: "probe-1" });
  await runtime.native.call("report", "surface composition failed: probe");
  assert.deepEqual(lines.splice(0), ["error page surface composition failed: probe"]);
});

test("a failed settling wait of a core command and a refused registration are error lines", async () => {
  const { connectExposure, registry, revisitRegistrations } = await import("../exposure.js");
  registry.declare("core", { status: [], dom: [], commands: [{
    name: "core.fixture.add", description: "Adds.",
    params: { type: "object", properties: { n: { type: "integer" } } }, result: { type: "integer" },
  }] });
  registry.command("core.fixture.add", ({ n }) => n + 1);
  await connectExposure({
    settled: async () => { throw new Error("surface tab-1 is not mounted"); },
    report,
  });
  lines.length = 0;
  assert.equal(await registry.run("core.fixture.add", { n: 1 }), 2);
  assert.deepEqual(lines.splice(0), ["error page exposure settled failed: surface tab-1 is not mounted"]);
  assert.throws(() => revisitRegistrations(), /requires report/);
});

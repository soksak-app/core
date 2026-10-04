// 페이지가 애플리케이션 로그로 보내는 줄의 수준을 검사한다. 오류는 `error: ` 로 시작하고 관측은 그렇지 않다
// (docs/spec/hosts.md#application-log). 창 검사는 이 형식으로 검사 동안의 오류를 찾는다.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const lines = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, payload) => {
    if (name === "report") lines.push(payload);
  },
} } });
const { log, report, surfaceContextRuntime } = await import("../host.js");

test("a reported failure starts with error: and an observation does not", async () => {
  lines.length = 0;
  await report("surface probe mount failed: x");
  await log("focus moved to probe");
  assert.deepEqual(lines.splice(0), ["error: surface probe mount failed: x", "focus moved to probe"]);
});

test("a surface module reports its failure as an error line", async () => {
  lines.length = 0;
  const runtime = surfaceContextRuntime({ surfaceId: "probe-1" });
  await runtime.native.call("report", "surface composition failed: probe");
  assert.deepEqual(lines.splice(0), ["error: surface composition failed: probe"]);
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
  assert.deepEqual(lines.splice(0), ["error: exposure settled failed: surface tab-1 is not mounted"]);
  assert.throws(() => revisitRegistrations(), /requires report/);
});

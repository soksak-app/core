// 페이지 성능 트레이스 생산자의 계약(docs/spec/performance-trace.md, V5-104).
import test from "node:test";
import assert from "node:assert/strict";
import { createTracer } from "../performance.js";

test("disabled page tracing does not format or relay a focus event", async (t) => {
  const calls = [];
  t.mock.module("@soksak/runtime", { exports: {
    host: { call: async (name, params) => { calls.push({ name, params }); } },
  } });
  const page = await import("../performance.js?disabled-focus");
  let formatted = 0;
  page.trace("focus", { get target() { formatted++; return "address"; } });
  assert.equal(calls.length, 0, "disabled tracing relayed a focus event");
  assert.equal(formatted, 0, "disabled tracing formatted a focus event");
});

test("tracing waits for enable and drains accepted events before disable", async () => {
  const { createTracer } = await import("../performance.js");
  const calls = [];
  let acknowledgeEnable;
  let acknowledgeLine;
  const tracer = createTracer((request) => {
    calls.push(request.action);
    if (request.action === "on") return new Promise((resolve) => { acknowledgeEnable = resolve; });
    if (request.action === "line") return new Promise((resolve) => { acknowledgeLine = resolve; });
    return Promise.resolve();
  });
  const enabling = tracer.setEnabled(true);
  await Promise.resolve();
  tracer.trace("focus", {});
  assert.deepEqual(calls, ["on"], "events preceded enable acknowledgment");
  acknowledgeEnable();
  await enabling;
  const line = tracer.trace("focus", {});
  await Promise.resolve();
  const disabling = tracer.setEnabled(false);
  tracer.trace("focus", {});
  assert.deepEqual(calls, ["on", "line"], "disable overtook an accepted event");
  acknowledgeLine();
  await line;
  await disabling;
  assert.deepEqual(calls, ["on", "line", "off"]);
});

test("tracing reports relay failure and rejects a failed switch", async () => {
  const { createTracer } = await import("../performance.js");
  const errors = [];
  const tracer = createTracer(async ({ action }) => {
    if (action === "line") throw new Error("relay failed");
    if (action === "off") throw new Error("switch failed");
  }, (error) => errors.push(error.message));
  await tracer.setEnabled(true);
  assert.equal(await tracer.timed("core.ok", async () => 42), 42);
  await assert.rejects(tracer.setEnabled(false), /switch failed/);
  assert.deepEqual(errors, ["relay failed"]);
});

test("trace formats a page line with a timestamp and the event", async () => {
  const lines = [];
  const tracer = createTracer(async ({ action, line }) => { if (action === "line") lines.push(line); });
  await tracer.setEnabled(true);
  await tracer.trace("action", { kind: "resize", width: 1200 });
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.equal(line.event, "action");
  assert.equal(line.kind, "resize");
  assert.equal(line.width, 1200);
  assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "ts is ISO-8601 with milliseconds");
});

test("timed reports the duration and passes the result and failure through", async () => {
  const lines = [];
  const tracer = createTracer(async ({ action, line }) => { if (action === "line") lines.push(line); });
  await tracer.setEnabled(true);
  const value = await tracer.timed("core.ok", async () => 42);
  await tracer.setEnabled(false);
  assert.equal(value, 42);
  assert.equal(lines[0].event, "command");
  assert.equal(lines[0].name, "core.ok");
  assert.equal(lines[0].ok, true);
  assert.ok(Number.isFinite(lines[0].us), "the duration is a number of microseconds");
  await tracer.setEnabled(true);
  await assert.rejects(
    tracer.timed("core.fail", async () => { throw new Error("boom"); }),
    /boom/,
  );
  await tracer.setEnabled(false);
  assert.equal(lines[1].ok, false);
  assert.equal(lines[1].error, "boom");
});

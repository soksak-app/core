// 페이지 성능 트레이스 생산자의 계약(docs/spec/performance-trace.md, V5-104).
import test from "node:test";
import assert from "node:assert/strict";
import { trace, timed } from "../performance.js";

test("trace formats a page line with a timestamp and the event", () => {
  const lines = [];
  trace("action", { kind: "resize", width: 1200 }, (line) => lines.push(line));
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.equal(line.event, "action");
  assert.equal(line.kind, "resize");
  assert.equal(line.width, 1200);
  assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "ts is ISO-8601 with milliseconds");
});

test("timed reports the duration and passes the result and failure through", async () => {
  const lines = [];
  const value = await timed("core.ok", async () => 42, (line) => lines.push(line));
  assert.equal(value, 42);
  assert.equal(lines[0].event, "command");
  assert.equal(lines[0].name, "core.ok");
  assert.equal(lines[0].ok, true);
  assert.ok(Number.isFinite(lines[0].us), "the duration is a number of microseconds");
  await assert.rejects(
    timed("core.fail", async () => { throw new Error("boom"); }, (line) => lines.push(line)),
    /boom/,
  );
  assert.equal(lines[1].ok, false);
  assert.equal(lines[1].error, "boom");
});

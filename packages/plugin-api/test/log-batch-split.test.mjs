// The page batch bound (docs/spec/logging.md#bounds): a batch carries at most 256 queued events, the rest follows in the next call,
// and each emitAndWait ends with the batch that carries its own record.
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBatcher } from "../log-batch.js";
import { withoutClock } from "./support/logging.mjs";

const hostClock = { ts_us: 1_791_000_000_000_456, mono_ns: 5_000_000_789 };
const answering = (inner) => (request) => (request.action === "clock" ? Promise.resolve(hostClock) : inner(withoutClock(request)));
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a batch carries at most 256 queued events, and the rest is sent in the next call, in order", async () => {
  const sizes = [];
  const indexes = [];
  const batcher = createEventBatcher({
    call: answering(async (request) => { sizes.push(request.events.length); indexes.push(...request.events.map((e) => e.fields.index)); }),
    report: assert.ifError,
  });
  for (let index = 0; index < 600; index += 1) batcher.emit("info", "page.test.many", { index });
  await batcher.flush();
  assert.deepEqual(sizes, [256, 256, 88]);
  assert.deepEqual(indexes, Array.from({ length: 600 }, (_, index) => index));
});

test("each emitAndWait ends with the batch that carries its record, across a split", async () => {
  // The second call is held open, so the records of the first batch can end while the records of the second batch still wait.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const batcher = createEventBatcher({
    call: answering(async () => { calls += 1; if (calls === 2) await held; }),
    report: assert.ifError,
  });
  const ended = new Set();
  const waits = [];
  for (let index = 0; index < 300; index += 1) {
    waits.push(batcher.emitAndWait("info", "page.test.waited", { index }).then(() => ended.add(index)));
  }
  await settle();
  assert.equal(calls, 2, "the second batch is in flight");
  assert.ok(ended.has(10) && ended.has(255), "the records of the first batch end with it");
  assert.ok(!ended.has(256) && !ended.has(280), "the records of the second batch wait for the second batch");
  release();
  await Promise.all(waits);
  assert.equal(calls, 2);
});

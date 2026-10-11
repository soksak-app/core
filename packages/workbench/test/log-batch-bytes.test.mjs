// The byte bound of the queue of the page writer (docs/spec/logging.md#bounds): events beyond it are refused and counted
// with their bytes by the event `page.log.dropped`.
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBatcher } from "../log-batch.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a queue over its byte bound refuses events and the next batch starts with the counted loss and its bytes", async () => {
  const calls = [];
  let acknowledge;
  const batcher = createEventBatcher({
    call: (request) => { calls.push(request); return new Promise((resolve) => { acknowledge = resolve; }); },
    report: assert.ifError,
    maxBytes: 1000,
  });
  batcher.emit("info", "page.test.held", {});
  await settle();
  const accepted = [1, 2, 3, 4].map((index) => batcher.emit("info", "page.test.event", { text: "x".repeat(300), index }));
  assert.deepEqual(accepted, [true, true, false, false]);
  acknowledge();
  await settle();
  const next = calls[1].events;
  assert.equal(next[0].event, "page.log.dropped");
  assert.equal(next[0].fields.count, 2);
  assert.ok(next[0].fields.bytes >= 600, `${next[0].fields.bytes} bytes`);
  assert.equal(next[0].fields.reason, "the page queue reached 1000 bytes");
  assert.equal(next.length, 3);
  acknowledge();
  await batcher.flush();
});

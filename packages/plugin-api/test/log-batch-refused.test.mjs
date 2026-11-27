// A batch that the host refuses is sent once and reported once; its events are counted as dropped in the next batch, and the batcher keeps
// working (docs/spec/logging.md#writers). A refusal that repeats every batch must not resend the same events without a bound.
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBatcher } from "../log-batch.js";

const PAGE = "6f1d2a3e-1111-4a2b-8c3d-00000000000a";
const settle = () => new Promise((resolve) => setImmediate(resolve));
const hostClock = { ts_us: 1_791_000_000_000_456, mono_ns: 5_000_000_789 };

test("a refused batch is reported once and its events are counted as dropped in the batch that follows the next event", async () => {
  const sent = [];
  const reported = [];
  let refuse = true;
  const call = async (request) => {
    if (request.action === "clock") return hostClock;
    sent.push(request);
    if (refuse) throw new Error("host refused the batch");
  };
  const batcher = createEventBatcher({ writer: { layer: "page", member: "page", identity: PAGE }, call, report: (error) => reported.push(error.message) });
  for (let index = 1; index <= 9; index += 1) batcher.emit("info", "page.test.event", { index });
  await settle();
  await settle();
  assert.equal(sent.length, 1, "the refused batch is sent once, and nothing is sent again without an event");
  assert.deepEqual(sent[0].events.map((event) => event.event).slice(0, 1), ["page.log.clock"]);
  assert.equal(sent[0].events.length, 10, "the first batch states the clock and the 9 events");
  assert.deepEqual(reported, ["page event batch of 10 events failed: host refused the batch"], "the refusal is reported once");
  batcher.emit("info", "page.test.second", {});
  await settle();
  await settle();
  assert.equal(sent.length, 2, "the next event starts one batch, which the host refuses too");
  assert.deepEqual(sent[1].events.map((event) => event.event), ["page.log.dropped", "page.test.second"], "the dropped events are counted in it");
  assert.equal(sent[1].events[0].fields.count, 10, "the 10 events of the refused batch, the clock included, are counted as dropped");
  assert.equal(reported.length, 2, "the second refusal is reported once");
  refuse = false;
  batcher.emit("info", "page.test.after", {});
  await settle();
  await settle();
  assert.equal(sent.length, 3);
  const next = sent[2].events;
  assert.deepEqual(next.map((event) => event.event), ["page.log.dropped", "page.test.after"], "the accepted batch states the 11 events dropped by the two refusals");
  assert.equal(next[0].fields.count, 11);
});

// The page side of the event writer (docs/spec/logging.md#writers): events of one turn travel to the host in one call.
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBatcher } from "../log-batch.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("events emitted in one turn are relayed in one call, in order", async () => {
  const calls = [];
  const batcher = createEventBatcher({ call: async (request) => { calls.push(request); }, report: assert.ifError });
  batcher.emit("info", "page.test.first", { index: 1 });
  batcher.emit("error", "page.test.second", { index: 2 });
  assert.equal(calls.length, 0, "an event was relayed before the turn ended");
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "batch");
  assert.deepEqual(calls[0].events.map((event) => [event.level, event.event, event.fields.index]),
    [["info", "page.test.first", 1], ["error", "page.test.second", 2]]);
  assert.ok(calls[0].events.every((event) => Number.isInteger(event.ts_us) && event.ts_us > 1.7e15));
});

test("events emitted while a call is in flight wait for it and keep their order", async () => {
  const calls = [];
  let acknowledge;
  const batcher = createEventBatcher({
    call: (request) => { calls.push(request); return new Promise((resolve) => { acknowledge = resolve; }); },
    report: assert.ifError,
  });
  batcher.emit("info", "page.test.a", {});
  await settle();
  batcher.emit("info", "page.test.b", {});
  await settle();
  assert.equal(calls.length, 1, "a second call started while the first was in flight");
  acknowledge();
  await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((request) => request.events.map((event) => event.event)), [["page.test.a"], ["page.test.b"]]);
  acknowledge();
  await batcher.flush();
});

test("a full queue refuses events and the next batch starts with the counted loss", async () => {
  const calls = [];
  let acknowledge;
  const batcher = createEventBatcher({
    call: (request) => { calls.push(request); return new Promise((resolve) => { acknowledge = resolve; }); },
    report: assert.ifError,
    maxEvents: 3,
  });
  batcher.emit("info", "page.test.held", {});
  await settle();
  const accepted = [1, 2, 3, 4, 5].map((index) => batcher.emit("info", "page.test.event", { index }));
  assert.deepEqual(accepted, [true, true, true, false, false]);
  acknowledge();
  await settle();
  const next = calls[1].events;
  assert.equal(next[0].event, "page.log.dropped");
  assert.equal(next[0].level, "warn");
  assert.equal(next[0].fields.count, 2);
  assert.equal(next.length, 4);
  acknowledge();
  await batcher.flush();
});

test("a failed call is reported with the number of events and does not block the next batch", async () => {
  const reports = [];
  let attempt = 0;
  const calls = [];
  const batcher = createEventBatcher({
    call: async (request) => { calls.push(request); if (++attempt === 1) throw new Error("host closed"); },
    report: (error) => reports.push(error.message),
  });
  batcher.emit("info", "page.test.lost", {});
  batcher.emit("info", "page.test.lost", {});
  await settle();
  batcher.emit("info", "page.test.kept", {});
  await batcher.flush();
  assert.deepEqual(reports, ["page event batch of 2 events failed: host closed"]);
  assert.equal(calls.length, 2);
});

test("an event with a level outside the contract is refused with an error", () => {
  const batcher = createEventBatcher({ call: async () => {}, report: assert.ifError });
  assert.throws(() => batcher.emit("loud", "page.test.event", {}), /level/);
});

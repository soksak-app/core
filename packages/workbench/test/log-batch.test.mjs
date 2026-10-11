// The page side of the event writer (docs/spec/logging.md#writers): events of one turn travel to the host in one call.
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBatcher } from "../log-batch.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

// The clocks of the host as the request `{action: "clock"}` answers them, and a call that answers them and passes the batches on.
const hostClock = { ts_us: 1_791_000_000_000_456, mono_ns: 5_000_000_789 };
const answering = (inner) => (request) => (request.action === "clock" ? Promise.resolve(hostClock) : inner(request));

test("events emitted in one turn are relayed in one call, in order", async () => {
  const calls = [];
  const batcher = createEventBatcher({ call: answering(async (request) => { calls.push(request); }), report: assert.ifError });
  batcher.emit("info", "page.test.first", { index: 1 });
  batcher.emit("error", "page.test.second", { index: 2 });
  assert.equal(calls.length, 0, "an event was relayed before the turn ended");
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "batch");
  assert.deepEqual(calls[0].events.map((event) => [event.level, event.event, event.fields.index]),
    [["info", "page.test.first", 1], ["error", "page.test.second", 2]]);
  assert.ok(calls[0].events.every((event) => Number.isInteger(event.ts_us) && event.ts_us > 1.7e15));
  assert.ok(calls[0].events.every((event) => Number.isInteger(event.mono_ns) && event.mono_ns > 0));
});

test("an event takes the wall clock and the monotonic clock of the host at its own reading, in microseconds and nanoseconds", async () => {
  let reading = 100;
  const calls = [];
  const batcher = createEventBatcher({ call: answering(async (request) => { calls.push(request); }), report: assert.ifError, now: () => reading });
  batcher.emit("info", "page.test.first", {});
  reading = 102.25;
  batcher.emit("info", "page.test.second", {});
  reading = 99.5;
  batcher.emit("info", "page.test.before", {});
  // The clock request takes no time on the clock of the page, so its answer is the moment 100.
  reading = 100;
  await settle();
  assert.deepEqual(calls[0].events.map((event) => [event.ts_us, event.mono_ns]), [
    [1_791_000_000_000_456, 5_000_000_789],
    [1_791_000_000_002_706, 5_002_250_789],
    [1_791_000_000_000_456 - 500, 5_000_000_789 - 500_000],
  ]);
  assert.ok(calls[0].events.every((event) => event.ts_us % 1000 !== 0), "a value that ends in three zeros is a rounding to a millisecond");
});

test("the clocks of the host are requested five times before the first batch, the shortest round trip anchors the page, and the anchor is kept", async () => {
  let reading = 0;
  const trips = [8, 2, 6, 4, 10];
  let sample = 0;
  const requests = [];
  const batches = [];
  const batcher = createEventBatcher({
    call: async (request) => {
      if (request.action === "clock") {
        requests.push(request);
        reading += trips[sample];
        sample += 1;
        return { ts_us: 1_791_000_000_000_000 + sample * 10_000, mono_ns: 5_000_000_000 + sample * 10_000_000 };
      }
      batches.push(request);
      return undefined;
    },
    report: assert.ifError,
    now: () => reading,
  });
  batcher.emit("info", "page.test.a", {});
  await settle();
  // The second sample has the round trip 2 from 8 to 10, so its answer (20_000 and 20_000_000) is the moment 9, and the event
  // was read at 0.
  assert.deepEqual([batches[0].events[0].ts_us, batches[0].events[0].mono_ns], [1_791_000_000_000_000 + 20_000 - 9_000, 5_000_000_000 + 20_000_000 - 9_000_000]);
  batcher.emit("info", "page.test.b", {});
  await settle();
  assert.equal(requests.length, 5, "five requests, once for the page");
  assert.deepEqual(requests[0], { action: "clock" });
  // The second event was read at 30, 21 after the anchor.
  assert.deepEqual([batches[1].events[0].ts_us, batches[1].events[0].mono_ns], [1_791_000_000_000_000 + 20_000 + 21_000, 5_000_000_000 + 20_000_000 + 21_000_000]);
});

test("a clock answer that is not two positive integers is reported with the number of events, and the next batch asks again", async () => {
  const reports = [];
  const batches = [];
  let answer = { ts_us: "now" };
  const batcher = createEventBatcher({
    call: async (request) => {
      if (request.action === "clock") return answer;
      batches.push(request);
      return undefined;
    },
    report: (error) => reports.push(error.message),
    now: () => 1,
  });
  batcher.emit("info", "page.test.lost", {});
  await settle();
  assert.deepEqual(reports, ['page event batch of 1 events failed: the host answered the clock request with {"ts_us":"now"}']);
  assert.equal(batches.length, 0);
  answer = hostClock;
  batcher.emit("info", "page.test.kept", {});
  await settle();
  assert.equal(batches.length, 1, "the clock was requested again and the batch left");
});

test("correlation identifiers travel with their event, and a list that the host would refuse is reported and left out", async () => {
  const reports = [];
  const calls = [];
  const batcher = createEventBatcher({
    call: answering(async (request) => { calls.push(request); }),
    report: (error) => reports.push(error.message),
  });
  batcher.emit("debug", "page.call", { name: "sidecarSend" }, ["b1.7", "b1.8"]);
  batcher.emit("debug", "page.call", { name: "windowState" });
  batcher.emit("debug", "page.call", { name: "a" }, []);
  batcher.emit("debug", "page.call", { name: "b" }, [""]);
  batcher.emit("debug", "page.call", { name: "c" }, ['a"b']);
  batcher.emit("debug", "page.call", { name: "d" }, "b1.7");
  await settle();
  const events = calls[0].events;
  assert.deepEqual(events.map((event) => [event.fields.name, event.cids]), [
    ["sidecarSend", ["b1.7", "b1.8"]], ["windowState", undefined], ["a", undefined], ["b", undefined], ["c", undefined], ["d", undefined],
  ]);
  assert.equal(Object.hasOwn(events[1], "cids"), false, "an event without identifiers has no cids");
  assert.equal(reports.length, 3);
  assert.match(reports[0], /the cids of page\.call are not an array of non-empty strings/);
});

test("events emitted while a call is in flight wait for it and keep their order", async () => {
  const calls = [];
  let acknowledge;
  const batcher = createEventBatcher({
    call: answering((request) => { calls.push(request); return new Promise((resolve) => { acknowledge = resolve; }); }),
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
    call: answering((request) => { calls.push(request); return new Promise((resolve) => { acknowledge = resolve; }); }),
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
    call: answering(async (request) => { calls.push(request); if (++attempt === 1) throw new Error("host closed"); }),
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
  const batcher = createEventBatcher({ call: answering(async () => {}), report: assert.ifError });
  assert.throws(() => batcher.emit("loud", "page.test.event", {}), /level/);
});

test("emitAndWait ends when the batch that carries the event was relayed, and the events of one turn share the batch", async () => {
  const calls = [];
  let release;
  const batcher = createEventBatcher({
    call: answering((request) => { calls.push(request.events.map((event) => event.event)); return new Promise((resolve) => { release = resolve; }); }),
    report: assert.ifError,
  });
  const first = batcher.emitAndWait("info", "page.test.a", {});
  const second = batcher.emitAndWait("info", "page.test.b", {});
  let ended = 0;
  first.then(() => { ended += 1; });
  second.then(() => { ended += 1; });
  await settle();
  assert.deepEqual(calls, [["page.test.a", "page.test.b"]], "one call carries both events");
  assert.equal(ended, 0, "the wait ended before the relay answered");
  release();
  await Promise.all([first, second]);
  assert.equal(ended, 2);
});

test("emitAndWait ends for an event that the full queue refused and for a batch whose call failed", async () => {
  const reports = [];
  let attempt = 0;
  const batcher = createEventBatcher({
    call: answering(async () => { if (++attempt === 1) throw new Error("host closed"); }),
    report: (error) => reports.push(error.message),
    maxEvents: 1,
  });
  const kept = batcher.emitAndWait("info", "page.test.kept", {});
  const refused = batcher.emitAndWait("info", "page.test.refused", {});
  await Promise.all([kept, refused]);
  // The refused event is counted in page.log.dropped, which travels in the batch of the kept event.
  assert.deepEqual(reports, ["page event batch of 2 events failed: host closed"]);
  await batcher.emitAndWait("info", "page.test.after", {});
  assert.equal(attempt, 2, "the next event was relayed after the failure");
});

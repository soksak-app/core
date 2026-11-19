// The report of the counts of the gate follows from the instants that the page passes (docs/spec/logging.md#policy).
import assert from "node:assert/strict";
import test from "node:test";
import { createEventBatcher, gatedDue } from "../log-batch.js";

const PAGE = "4f19c177-b0bc-4991-9f93-d9efc4a800a1";
const hostClock = { ts_us: 1_791_000_000_000_000, mono_ns: 5_000_000_000 };

test("the counts are due when a count is held and the interval has passed since the last report", () => {
  const table = [
    { counted: true, gatedAt: 0, at: 999, interval: 1000, due: false },
    { counted: true, gatedAt: 0, at: 1000, interval: 1000, due: true },
    { counted: true, gatedAt: 400, at: 1399, interval: 1000, due: false },
    { counted: true, gatedAt: 400, at: 1400, interval: 1000, due: true },
    { counted: false, gatedAt: 0, at: 5000, interval: 1000, due: false },
    { counted: true, gatedAt: 0, at: 0, interval: 0, due: true },
    { counted: true, gatedAt: 0, at: 999, due: false },
    { counted: true, gatedAt: 0, at: 1000, due: true },
  ];
  for (const { due, ...input } of table) assert.equal(gatedDue(input), due, JSON.stringify(input));
});

// The run time of the code is not an input: the same refusals at the same instants make the same batches however long the code runs.
test("the batch that carries a count follows from the instants that the page passes, and not from the time that the test takes", async () => {
  const batches = [];
  const timers = [];
  let instant = 0;
  const batcher = createEventBatcher({ writer: { layer: "page", member: "page", identity: PAGE },
    call: async (request) => {
      if (request.action === "clock") return hostClock;
      batches.push(request);
      return undefined;
    },
    report: assert.ifError,
    classify: () => "call",
    gate: { enabled: () => false },
    now: () => instant,
    timer: (callback, ms) => timers.push({ callback, ms }),
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // Three counts at instants inside one interval, however long the code takes to run between them.
  for (const at of [0, 400, 999]) {
    instant = at;
    batcher.emit("debug", "page.test.call");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(batches.length, 0, "a count left before its interval had passed");
  assert.deepEqual(timers.map(({ ms }) => ms), [1000], "one timer waits for the interval that began at the first count");
  // The timer fires when the instant reaches the end of the interval: one batch carries the count of the three refusals.
  instant = 1000;
  timers[0].callback();
  await settle();
  await settle();
  assert.deepEqual(batches.flatMap((request) => request.events).filter(({ event }) => event === "page.log.gated").map(({ fields }) => fields.count), [3]);
  assert.equal(batches.length, 1);
});

// A producer asks before it reads costly fields whether the event would be stored. The answer is that of the writers
// (PassesEveryGate of sok, passes_every_gate of soksak_sok::event_log): an event without a class, an event that passes every gate and
// an event that the policy stores (docs/spec/logging.md#policy).
test("admits answers as the writers judge an event, the events that pass every gate included, and counts nothing", async () => {
  const batches = [];
  const classes = { "workbench.start": "lifecycle", "workbench.log.clock": "lifecycle", "workbench.fixture.step": "lifecycle",
    "workbench.command": "call", "workbench.layout.change": "call", "workbench.keyboard.follow": "input" };
  const batcher = createEventBatcher({ writer: { layer: "workbench", member: "start", identity: PAGE },
    call: async (request) => {
      if (request.action === "clock") return hostClock;
      batches.push(request);
      return undefined;
    },
    report: assert.ifError,
    classify: (event) => classes[event],
    gate: { enabled: (klass, level) => klass === "call" && (level === "warn" || level === "error") },
  });
  assert.deepEqual(["workbench.start", "workbench.log.clock", "workbench.fixture.step"].map((event) => batcher.admits("info", event)),
    [true, true, true], "an event that passes every gate is admitted under a closed gate");
  assert.equal(batcher.admits("debug", "workbench.layout.change"), false, "the policy refuses call at debug");
  assert.equal(batcher.admits("warn", "workbench.command"), true, "the policy stores call at warn");
  assert.equal(batcher.admits("debug", "workbench.keyboard.follow"), false);
  assert.equal(batcher.admits("debug", "workbench.undeclared"), true, "an event without a class is not gated");
  assert.throws(() => batcher.admits("loud", "workbench.command"), { message: 'event level "loud" is not one of error, warn, info, debug, trace' });
  batcher.emit("error", "workbench.command", { name: "x" });
  await batcher.flush();
  const events = batches.flatMap((batch) => batch.events ?? []).map(({ event }) => event);
  assert.equal(events.includes("workbench.log.gated"), false, `admits counted a refusal: ${events}`);
});

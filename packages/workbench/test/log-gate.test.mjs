// The gate of the page (docs/spec/logging.md#classes-and-policy): the policy says for each class the least severe level that is
// stored; the page asks the gate before it builds the fields of an event, and it counts what it did not build.
import assert from "node:assert/strict";
import test from "node:test";

import { createLogGate, logPolicyOf } from "../log-gate.js";
import { createEventBatcher } from "../log-batch.js";
import { withoutClock } from "./support/records.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const hostClock = { ts_us: 1_791_000_000_000_456, mono_ns: 5_000_000_789 };
const answering = (inner) => (request) => (request.action === "clock" ? Promise.resolve(hostClock) : inner(withoutClock(request)));

const everything = { lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" };

const onlyErrors = Object.fromEntries(Object.keys(everything).map((name) => [name, "error"]));

test("the gate stores only errors until a policy is set, and a policy decides each class and level", () => {
  const gate = createLogGate();
  for (const klass of Object.keys(everything)) {
    assert.equal(gate.enabled(klass, "error"), true, `${klass} error`);
    for (const level of ["warn", "info", "debug", "trace"]) assert.equal(gate.enabled(klass, level), false, `${klass} ${level}`);
  }
  assert.deepEqual(gate.classes(), onlyErrors);
  assert.equal(gate.set({ ...everything, input: "debug", call: "info", io: "off", frame: "error" }), true);
  assert.deepEqual(["input debug", "input trace", "call info", "call debug", "io error", "frame error", "frame warn", "lifecycle trace"]
    .map((text) => gate.enabled(...text.split(" "))), [true, false, true, false, false, true, false, true]);
  // The same policy again changes nothing, and a class that no catalog entry gives is not gated.
  assert.equal(gate.set({ ...everything, input: "debug", call: "info", io: "off", frame: "error" }), false);
  assert.equal(gate.enabled(undefined, "debug"), true);
  assert.deepEqual(gate.classes(), { lifecycle: "trace", input: "debug", call: "info", io: "off", frame: "error" });
});

test("a policy that leaves a class out, names a class that does not exist or has a level outside the contract is refused and the policy in force stays", () => {
  const gate = createLogGate();
  gate.set({ ...everything, call: "warn" });
  const { lifecycle, ...missing } = everything;
  assert.throws(() => gate.set(missing), /the class lifecycle is missing/);
  assert.throws(() => gate.set({ ...everything, audio: "trace" }), /the class audio is not one of lifecycle, input, call, io, frame/);
  assert.throws(() => gate.set({ ...everything, input: "loud" }), /the level "loud" of the class input is not one of off, error, warn, info, debug, trace/);
  assert.throws(() => gate.set({ ...everything, input: 4 }), /the level of the class input must be text, found 4/);
  assert.throws(() => gate.set(null), /the policy must be an object/);
  assert.equal(gate.enabled("call", "info"), false, "a refused policy changed the policy in force");
});

test("logPolicyOf completes the setting diagnostics.log with error for the classes it does not name", () => {
  assert.deepEqual(logPolicyOf({}), onlyErrors);
  assert.deepEqual(logPolicyOf({ call: "info", io: "off" }), { ...onlyErrors, call: "info", io: "off" });
  assert.throws(() => logPolicyOf({ audio: "off" }), /the class audio is not one of lifecycle, input, call, io, frame/);
});

test("a closed gate builds no fields, relays nothing, and reports the exact count as page.log.gated at a flush", async () => {
  const gate = createLogGate();
  gate.set({ ...everything, call: "info", io: "off" });
  const batches = [];
  const batcher = createEventBatcher({ call: answering(async (request) => { batches.push(request); }), report: assert.ifError, gate });
  let built = 0;
  const fields = () => { built += 1; return { name: "x" }; };
  for (let index = 0; index < 4; index += 1) assert.equal(batcher.emit("debug", "page.call", fields), false);
  assert.equal(batcher.emit("warn", "page.call", fields), true, "a warning of the class call passes a policy that stores it from info on");
  assert.equal(batcher.gate("call", "debug"), false);
  assert.equal(batcher.gate("call", "info"), true);
  assert.equal(batcher.emit("info", "page.start", () => ({ time_origin: 1, url: "u" })), true);
  await batcher.flush();
  assert.equal(built, 1, "the fields of a closed gate were built");
  const events = batches.flatMap((request) => request.events);
  assert.deepEqual(events.map((event) => event.event), ["page.log.gated", "page.call", "page.start"]);
  assert.deepEqual(events[0].fields, { class: "call", level: "debug", count: 5 });
  assert.equal(events[0].level, "info");
  assert.equal(batcher.gate("call", "debug"), false);
  await batcher.flush();
  const later = batches.flatMap((request) => request.events).filter((event) => event.event === "page.log.gated");
  assert.deepEqual(later.map((event) => event.fields), [{ class: "call", level: "debug", count: 5 }, { class: "call", level: "debug", count: 1 }]);
});

test("an event that the catalog does not declare is not gated, and the report of the gate passes a gate that turns the class lifecycle off", async () => {
  const gate = createLogGate();
  gate.set({ ...everything, lifecycle: "off", call: "off" });
  const batches = [];
  const batcher = createEventBatcher({ call: answering(async (request) => { batches.push(request); }), report: assert.ifError, gate });
  assert.equal(batcher.emit("debug", "plugin.editor.opened", { file: "a" }), true);
  assert.equal(batcher.emit("debug", "page.call", { name: "x" }), false);
  await batcher.flush();
  assert.deepEqual(batches.flatMap((request) => request.events).map((event) => event.event), ["page.log.gated", "plugin.editor.opened"]);
});

test("the counts of a closed gate leave each second and at a flush, not with each batch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = createLogGate();
  gate.set({ ...everything, call: "info" });
  const batches = [];
  let clock = 0;
  const batcher = createEventBatcher({
    call: answering(async (request) => { batches.push(request); }), report: assert.ifError, gate, now: () => clock,
  });
  const gatedOf = () => batches.flatMap((request) => request.events).filter((event) => event.event === "page.log.gated").map((event) => event.fields);
  // Ten batches within 900 ms each carry an event and follow refused events.
  for (let round = 0; round < 10; round += 1) {
    clock = round * 100;
    batcher.emit("debug", "page.call", { name: "x" });
    batcher.emit("debug", "page.call", { name: "x" });
    batcher.emit("info", "page.start", { time_origin: 1, url: "u" });
    await settle();
  }
  assert.deepEqual(gatedOf(), [], "the counts left with a batch within a second");
  // The timer was armed at the first refusal, at the time 0, for the end of the second.
  clock = 999;
  t.mock.timers.tick(999);
  await settle();
  assert.deepEqual(gatedOf(), [], "the counts left before the second ended");
  clock = 1000;
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(gatedOf(), [{ class: "call", level: "debug", count: 20 }]);
  clock = 1100;
  batcher.emit("debug", "page.call", { name: "x" });
  await batcher.flush();
  assert.deepEqual(gatedOf(), [{ class: "call", level: "debug", count: 20 }, { class: "call", level: "debug", count: 1 }]);
});

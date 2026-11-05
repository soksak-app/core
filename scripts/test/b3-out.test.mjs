import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { b3Conditions, readB3Out, writeB3Out } from "../b3-out.mjs";

const POLICY = { lifecycle: "error", input: "error", call: "debug", io: "error", frame: "debug" };

/** A host.window reply of the window `window` with the members that the conditions read; the caller adds the window id it read the reply for. */
const reply = (window, members = {}) => ({ window, refreshRate: 120, scale: 2, content: { width: 1200, height: 760 }, pageProcess: null, occluded: false, active: true, ...members });

test("the conditions of a run are the refresh rate and the backing scale that every window shares, the content size of the first window, the performance switch and the policy", () => {
  assert.deepEqual(b3Conditions({ windows: [reply("w1")], performance: true, policy: POLICY }),
    { refreshRate: 120, backingScale: 2, traceState: true, logPolicy: POLICY, window: { width: 1200, height: 760 }, occluded: false, active: true });
  const two = b3Conditions({ windows: [reply("w1"), reply("w2", { content: { width: 600, height: 400 } })], performance: false, policy: POLICY });
  assert.equal(two.traceState, false);
  assert.deepEqual(two.window, { width: 1200, height: 760 }, "the window of the conditions is the first window, the window of the state");
  assert.throws(() => b3Conditions({ windows: [reply("w1"), reply("w2", { scale: 1 })], performance: false, policy: POLICY }),
    /window w2 reports refreshRate 120 and scale 1, not refreshRate 120 and scale 2 of window w1/);
  assert.throws(() => b3Conditions({ windows: [reply("w1"), reply("w2", { refreshRate: 60 })], performance: false, policy: POLICY }),
    /window w2 reports refreshRate 60 and scale 2, not refreshRate 120 and scale 2 of window w1/);
  assert.throws(() => b3Conditions({ windows: [reply("w1", { refreshRate: null })], performance: false, policy: POLICY }),
    /window w1 reports the refresh rate null, so it is on no screen/);
  assert.throws(() => b3Conditions({ windows: [reply("w1", { scale: 0 })], performance: false, policy: POLICY }),
    /window w1 reports scale 0, not a backing scale/);
  assert.throws(() => b3Conditions({ windows: [{ refreshRate: 120, scale: 2, content: { width: 1200, height: 760 } }], performance: false, policy: POLICY }),
    /a host\.window reply of b3Conditions names its window, not undefined/);
  assert.throws(() => b3Conditions({ windows: [], performance: false, policy: POLICY }), /b3Conditions needs one or more host\.window replies, not \[\]/);
  assert.throws(() => b3Conditions({ windows: [reply("w1")], performance: 1, policy: POLICY }),
    /the performance switch of a B3 run is true or false, not 1/);
});

test("the B3 output holds the measurements and the conditions, and refuses a value that is not a number, passed or failed", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "b3-out-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, "object-counts.json");
  const conditions = b3Conditions({ windows: [reply("w1")], performance: false, policy: POLICY });
  writeB3Out(file, { measurements: { changedCounts: 0, growingFigures: 1, verdict: "passed" }, conditions });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")),
    { measurements: { changedCounts: 0, growingFigures: 1, verdict: "passed" }, conditions });
  assert.throws(() => writeB3Out(file, { measurements: { changedCounts: Number.NaN }, conditions }),
    /B3 measurement changedCounts must be a finite number, "passed" or "failed", not NaN/);
  assert.throws(() => writeB3Out(file, { measurements: { verdict: "ok" }, conditions }),
    /B3 measurement verdict must be a finite number, "passed" or "failed", not "ok"/);
  assert.throws(() => writeB3Out(file, { measurements: {}, conditions }), /the B3 output has no measurement/);
  assert.throws(() => writeB3Out(file, { measurements: { a: 1 }, conditions: { ...conditions, traceState: "frame-records" } }),
    /B3 condition traceState must be true or false, not "frame-records"/);
  assert.throws(() => writeB3Out(file, { measurements: { a: 1 }, conditions: { ...conditions, traceState: 1 } }),
    /B3 condition traceState must be true or false, not 1/);
  assert.throws(() => writeB3Out(file, { measurements: { a: 1 }, conditions: { ...conditions, window: { width: 1200 } } }),
    /B3 condition window must be \{width, height\} of positive numbers, not \{"width":1200\}/);
});

test("the reader returns what the writer wrote and refuses a file outside the form with the file and the bad key", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "b3-out-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, "run.json");
  const conditions = b3Conditions({ windows: [reply("w1")], performance: true, policy: POLICY });
  writeB3Out(file, { measurements: { changedCounts: 2, verdict: "failed" }, conditions });
  assert.deepEqual(readB3Out(file), { measurements: { changedCounts: 2, verdict: "failed" }, conditions });
  const refused = (output, pattern) => {
    writeFileSync(file, typeof output === "string" ? output : JSON.stringify(output));
    assert.throws(() => readB3Out(file), (error) => error.message.startsWith(`${file}: `) && pattern.test(error.message));
  };
  refused("{", /not JSON/);
  refused({ measurements: { a: 1 } }, /the B3 output must have the members measurements and conditions, not measurements/);
  refused({ measurements: { a: 1 }, conditions, extra: 1 }, /the B3 output must have the members measurements and conditions, not measurements, conditions, extra/);
  refused({ measurements: { a: "1" }, conditions }, /B3 measurement a must be a finite number, "passed" or "failed", not "1"/);
  refused({ measurements: { a: 1 }, conditions: { ...conditions, traceState: 0 } }, /B3 condition traceState must be true or false, not 0/);
  refused({ measurements: { a: 1 }, conditions: { ...conditions, backingScale: 0 } }, /B3 condition backingScale must be a positive number, not 0/);
  refused({ measurements: { a: 1 }, conditions: { ...conditions, screen: 1 } },
    /B3 conditions must be refreshRate, backingScale, traceState, logPolicy, window, occluded, active, not refreshRate, backingScale, traceState, logPolicy, window, occluded, active, screen/);
  const { logPolicy, ...withoutPolicy } = conditions;
  refused({ measurements: { a: 1 }, conditions: withoutPolicy },
    /B3 conditions must be refreshRate, backingScale, traceState, logPolicy, window, occluded, active, not refreshRate, backingScale, traceState, window, occluded, active/);
  refused({ measurements: { a: 1 }, conditions: { ...conditions, logPolicy: { ...POLICY, frame: "loud" } } },
    /B3 condition logPolicy: .*the level "loud" of the class frame is not one of off, error, warn, info, debug, trace/);
  refused({ measurements: { a: 1 }, conditions: { ...conditions, logPolicy: { frame: "debug" } } },
    /B3 condition logPolicy must name the classes lifecycle, input, call, io, frame, not frame/);
});

test("the conditions of a run state whether the first window, the window of the state, is covered", () => {
  const conditions = (first) => b3Conditions({ windows: [reply("w1", first), reply("w2", { occluded: false })], performance: false, policy: POLICY });
  assert.equal(conditions({ occluded: true }).occluded, true);
  assert.equal(conditions({ occluded: false }).occluded, false);
  assert.throws(() => conditions({ occluded: null }), /window w1 reports occluded null, not true or false/);
});

test("the conditions of a run state whether the application of the first window is active", () => {
  const conditions = (first) => b3Conditions({ windows: [reply("w1", first)], performance: false, policy: POLICY });
  assert.equal(conditions({ active: true }).active, true);
  assert.equal(conditions({ active: false }).active, false);
  assert.throws(() => conditions({ active: null }), /window w1 reports active null, not true or false/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { Soksak } from "../dist/index.js";
import * as sequences from "../scripts/layout-sequences.mjs";

import { fuzz, three } from "./helpers.mjs";
import { allOperations, assertInvariants, assertSequence, createProfile, runSequence } from "../scripts/layout-sequences.mjs";

test("random sequences detect an invalid intermediate state before a later operation repairs it", { timeout: 5000 }, () => {
  const grid = three();
  let transitions = 0;
  for (const method of ["split", "close", "tidy", "moveBoundary", "mergeCoincident"]) {
    const original = grid[method].bind(grid);
    grid[method] = (...args) => { transitions++; return original(...args); };
  }
  const rects = grid.rects.bind(grid);
  grid.rects = () => {
    const result = rects();
    if (transitions === 1) {
      const [id, rect] = result.entries().next().value;
      result.set(id, { ...rect, w: NaN });
    }
    return result;
  };
  assert.throws(() => fuzz(grid, 4, 8), /rect-finite/);
  assert.equal(transitions, 1, "the failing transition stops before its repair");
});

test("sequence reports retain deterministic calls and successful and refused outcomes", { timeout: 5000 }, () => {
  const operations = [
    { method: "split", args: ["card", "x", { id: "second" }] },
    { method: "close", args: ["absent"] },
    { method: "close", args: ["second"] },
  ];
  const report = assertSequence(runSequence(createProfile("ordinary"), { seed: 17, operations }));
  assert.deepEqual(report.counts, { successful: 2, refused: 1, changed: 2, unchanged: 1 });
  assert.deepEqual(report.byMethod.close, { successful: 1, refused: 1, changed: 1, unchanged: 1 });
  assert.deepEqual(report.trace.map(({ outcome }) => outcome), ["successful", "refused", "successful"]);
  assert.deepEqual(report.initial.state.cards.map(({ id }) => id), ["card"]);
  for (const profile of ["ordinary", "fixed", "constrained"]) {
    const run = () => assertSequence(runSequence(createProfile(profile, 7), { seed: 7, steps: 30, profile }));
    assert.deepEqual(run(), run(), profile);
  }
});

test("constrained profiles allow zero-size cards while retaining slot coverage", { timeout: 5000 }, () => {
  const grid = createProfile("fixed");
  grid.resize(0, 0);
  assert.doesNotThrow(() => assertInvariants(grid, "constrained"));
  assert.throws(() => assertInvariants(grid, "fixed"), /positive-area/);
});

test("refused transitions are checked and cannot silently mutate the layout", { timeout: 5000 }, () => {
  const grid = createProfile("ordinary");
  grid.close = () => { grid.resize(1000, 800); return false; };
  const report = runSequence(grid, { operations: [{ method: "close", args: ["card"] }] });
  assert.equal(report.failure.invariant, "refusal-state");
  assert.deepEqual(report.counts, { successful: 0, refused: 1, changed: 1, unchanged: 0 });
});

test("shared profiles exercise every operation and both transition outcomes", { timeout: 10000 }, () => {
  const seen = new Set();
  for (const profile of ["ordinary", "fixed", "constrained"]) {
    const totals = { successful: 0, refused: 0 };
    const byMethod = {};
    for (let seed = 1; seed <= 12; seed++) {
      const report = assertSequence(runSequence(createProfile(profile, seed), { seed, steps: 40, profile }));
      for (const entry of report.trace) seen.add(entry.method);
      for (const key of Object.keys(totals)) totals[key] += report.counts[key];
      for (const [method, counts] of Object.entries(report.byMethod)) {
        const sum = byMethod[method] ??= { successful: 0, refused: 0 };
        sum.successful += counts.successful;
        sum.refused += counts.refused;
      }
    }
    assert.ok(totals.successful > 0 && totals.refused > 0, `${profile}: ${JSON.stringify(totals)}`);
    const structural = profile === "ordinary" ? ["split", "close"] : profile === "fixed" ? ["splitToward", "close", "move", "insertAt"] : ["split", "close", "move", "insertAt"];
    for (const method of structural) {
      assert.ok(byMethod[method].successful > 0 && byMethod[method].refused > 0, `${profile}/${method}: ${JSON.stringify(byMethod[method])}`);
    }
  }
  assert.deepEqual([...seen].sort(), [...allOperations].sort());
});

test("sequence evidence distinguishes an accepted merge from a refused merge", { timeout: 5000 }, () => {
  const grid = new Soksak({
    xs: [0, 0.5, 0.75, 1], ys: [0, 0.5, 1],
    cards: [
      { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "b", c0: 1, c1: 3, r0: 0, r1: 1 },
      { id: "under", c0: 0, c1: 3, r0: 1, r1: 2 },
    ],
  }, { width: 1600, height: 1200 });
  const report = assertSequence(runSequence(grid, { operations: [
    { method: "mergeCoincident", args: ["x", 1] },
    { method: "moveBoundary", args: ["x", 1, 1197] },
    { method: "mergeCoincident", args: ["x", 1] },
  ] }));
  assert.deepEqual(report.byMethod.mergeCoincident, { successful: 1, refused: 1, changed: 1, unchanged: 1 });
  assert.equal(grid.lines("x").length, 3);
  assert.equal(grid.cards.length, 3);
});

function reductionFixture() {
  const grid = createProfile("ordinary");
  const split = grid.split.bind(grid);
  grid.split = (...args) => {
    const armed = grid.card("card").data?.armed;
    const result = split(...args);
    grid.failure = armed ? "rect-finite" : "rect-overlap";
    return result;
  };
  return grid;
}

function fixtureInvariant(grid) {
  assertInvariants(grid);
  if (grid.failure) {
    const error = new Error(`${grid.failure}: controlled faulty split`);
    error.invariant = grid.failure;
    throw error;
  }
}

test("shrinking retains the original trace and deterministically preserves the same invariant", { timeout: 5000 }, () => {
  const operations = [
    { method: "resize", args: [1400, 1000] },
    { method: "setData", args: ["card", { unused: true }] },
    { method: "setData", args: ["card", { armed: true }] },
    { method: "resize", args: [1200, 800] },
    { method: "split", args: ["card", "x", { id: "trigger" }] },
  ];
  const report = runSequence(reductionFixture(), { seed: 91, operations, check: fixtureInvariant });
  assert.equal(report.failure.invariant, "rect-finite");
  const before = structuredClone(report);
  const options = { create: reductionFixture, check: fixtureInvariant };
  const result = sequences.reduceSequence(report, options);
  assert.deepEqual(result.original, before);
  assert.deepEqual(report, before, "reduction does not mutate the evidence");
  assert.equal(result.reduced.seed, 91);
  assert.deepEqual(result.reduced.trace.map(({ method, args }) => ({ method, args })), [operations[2], operations[4]]);
  assert.equal(result.reduced.failure.invariant, "rect-finite");
  assert.deepEqual(sequences.reduceSequence(report, options), result);
  assert.equal(sequences.replaySequence(report, [operations[4]], options).failure.invariant, "rect-overlap");
  assert.equal(sequences.replaySequence(report, [operations[2]], options).failure, null);
});

test("shrinking rejects passing sequences and failure identities that do not replay", { timeout: 5000 }, () => {
  const passing = runSequence(createProfile("ordinary"), { steps: 2 });
  assert.throws(() => sequences.reduceSequence(passing), /passing sequence/);
  const wrong = { ...passing, failure: { invariant: "rect-finite", message: "expected", step: 1 } };
  assert.throws(() => sequences.reduceSequence(wrong), /does not reproduce rect-finite/);
});

test("shrinking refuses untagged assertions instead of conflating distinct failures", { timeout: 5000 }, () => {
  const check = (grid) => {
    if (grid.failure) assert.fail(grid.failure === "rect-finite" ? "original assertion" : "different assertion");
  };
  const operations = [
    { method: "setData", args: ["card", { armed: true }] },
    { method: "split", args: ["card", "x", { id: "trigger" }] },
  ];
  const report = runSequence(reductionFixture(), { operations, check });
  const options = { create: reductionFixture, check };
  const alternative = sequences.replaySequence(report, [operations[1]], options);
  assert.equal(report.failure.invariant, "assertion");
  assert.equal(alternative.failure.invariant, "assertion");
  assert.notEqual(report.failure.message, alternative.failure.message);
  assert.throws(() => sequences.reduceSequence(report, options), /requires a named invariant/);
});

test("replay preserves nondefault snapping and every recorded layout option", { timeout: 5000 }, () => {
  const grid = new Soksak({
    xs: [0, 0.5, 0.75, 1], ys: [0, 0.5, 1],
    cards: [
      { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "b", c0: 1, c1: 3, r0: 0, r1: 1 },
      { id: "under", c0: 0, c1: 3, r0: 1, r1: 2 },
    ],
  }, { width: 1600, height: 1200, gap: 17, minSize: 51, snapDistance: 40, grabSize: 23, snap: "merge", fillOrder: "h" });
  const report = assertSequence(runSequence(grid, { operations: [
    { method: "moveBoundary", args: ["x", 1, 1180] },
    { method: "mergeCoincident", args: ["x", 1] },
  ] }));
  assert.equal(report.trace[1].result, true, "20px distance snaps only with the recorded 40px option");
  assert.deepEqual(sequences.replaySequence(JSON.parse(JSON.stringify(report))), report);
  const changed = structuredClone(report);
  changed.initial.options.snapDistance = 7;
  assert.equal(sequences.replaySequence(changed).trace[1].result, false);
});

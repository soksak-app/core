import assert from "node:assert/strict";
import test from "node:test";
import { Soksak } from "../dist/index.js";

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

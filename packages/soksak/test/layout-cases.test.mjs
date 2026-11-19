import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Soksak, outline } from "../dist/index.js";

/**
 * The shared layout cases (docs/spec/cases/layout). The Go layout model of
 * packages/workbench-mygo runs the same files, so a case is one statement of
 * the layout that both implementations meet.
 */
const read = (name) => JSON.parse(readFileSync(new URL(`../../../docs/spec/cases/layout/${name}`, import.meta.url), "utf8"));

/** Two numbers are the same when they differ by less than this, relative to the larger. */
const TOLERANCE = 1e-9;

/** The value as JSON holds it: a Map is an object, a value of undefined is absent. */
function plain(value) {
  if (value instanceof Map) return plain(Object.fromEntries(value));
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

/** Asserts that actual holds expected, numbers within TOLERANCE, and names the path of the first difference. */
function same(actual, expected, where) {
  if (typeof expected === "number") {
    assert.equal(typeof actual, "number", `${where}: ${JSON.stringify(actual)} is not a number`);
    assert.ok(Math.abs(actual - expected) <= TOLERANCE * Math.max(1, Math.abs(actual), Math.abs(expected)),
      `${where}: ${actual} is not ${expected}`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where}: ${JSON.stringify(actual)} is not a list`);
    assert.equal(actual.length, expected.length, `${where}: ${actual.length} items, not ${expected.length}`);
    expected.forEach((item, i) => same(actual[i], item, `${where}[${i}]`));
    return;
  }
  if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object" && !Array.isArray(actual), `${where}: ${JSON.stringify(actual)} is not an object`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${where}: the keys differ`);
    for (const key of Object.keys(expected)) same(actual[key], expected[key], `${where}.${key}`);
    return;
  }
  assert.equal(actual, expected, where);
}

/** Runs one step on the grid: `get` and `set` read and write a property, any other call is the method of that name. */
function call(grid, { call: name, args = [] }) {
  if (name === "get") return grid[args[0]];
  if (name === "set") {
    grid[args[0]] = args[1];
    return undefined;
  }
  assert.equal(typeof grid[name], "function", `the grid has no method ${name}`);
  return grid[name](...args);
}

/** Runs a step and checks its result: the value of `returns`, the message of `throws`, or no value. */
function check(run, step, where) {
  if (Object.hasOwn(step, "throws")) {
    assert.throws(run, (error) => error.message === step.throws, `${where}: does not throw ${step.throws}`);
    return;
  }
  const result = plain(run());
  if (Object.hasOwn(step, "returns")) same(result, step.returns, where);
  else assert.equal(result, undefined, `${where}: returns ${JSON.stringify(result)}`);
}

for (const kase of read("grid.json").cases) {
  test(`grid: ${kase.name}`, () => {
    let grid;
    check(() => { grid = new Soksak(kase.state, kase.options); }, kase, "the construction");
    if (Object.hasOwn(kase, "throws")) return;
    kase.steps.forEach((step, i) => check(() => call(grid, step), step, `step ${i + 1} ${step.call}`));
  });
}

for (const kase of read("outline.json").cases) {
  test(`outline: ${kase.name}`, () => {
    check(() => outline(kase.rects, kase.options), kase, "outline");
  });
}

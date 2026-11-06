import assert from "node:assert/strict";
import test from "node:test";
import { Soksak } from "../dist/index.js";

const state = {
  xs: [0, 0.3, 1], ys: [0, 1],
  cards: [
    { id: "left", c0: 0, c1: 1, r0: 0, r1: 1, width: 180, fixed: true },
    { id: "upper", c0: 1, c1: 2, r0: 0, r1: 1, data: { id: "left" } },
  ],
};
const options = { width: 1600, height: 1200 };
const operations = [
  { method: "close", args: ["left"] },
  { method: "split", args: ["upper", "x", { id: "child" }] },
  { method: "close", args: ["child"] },
  { method: "setSize", args: ["left", "x", 220] },
];

test("role comparison sends renamed and permuted inputs to the public layout API", { timeout: 5000 }, async () => {
  const { assertRoleIndependence } = await import("../scripts/layout-equivalence.mjs");
  const inputs = [];
  const result = assertRoleIndependence({ state, options, operations, create(value, settings) {
    inputs.push(structuredClone(value));
    return new Soksak(value, settings);
  } });
  assert.ok(inputs.some((value) => value.cards[0].id === "upper"), "the reversed array reaches the constructor");
  assert.ok(inputs.some((value) => value.cards.every((card) => !["left", "upper"].includes(card.id))), "renamed ids reach the constructor");
  assert.ok(result.variants >= 3);
  assert.deepEqual(result.outcomes, [false, "child", true, true]);
  assert.equal(result.initial.cards.find((card) => card.id === "left").rect.w, 180);
  assert.equal(result.final.cards.find((card) => card.id === "left").rect.w, 220);
  assert.deepEqual(result.final.cards.find((card) => card.id === "upper").data, { id: "left" }, "opaque data is not renamed");
});

test("role comparison rejects an injected identifier-dependent operation choice", { timeout: 5000 }, async () => {
  const { assertRoleIndependence } = await import("../scripts/layout-equivalence.mjs");
  assert.throws(() => assertRoleIndependence({ state, options, operations, create(value, settings) {
    const grid = new Soksak(value, settings);
    const split = grid.split.bind(grid);
    const refused = new Set(["upper"]);
    grid.split = (id, ...args) => refused.has(id) ? null : split(id, ...args);
    return grid;
  } }), /role independence/);
});

test("role comparison rejects geometry chosen from the first input card", { timeout: 5000 }, async () => {
  const { assertRoleIndependence } = await import("../scripts/layout-equivalence.mjs");
  assert.throws(() => assertRoleIndependence({ state, options, operations, create(value, settings) {
    const grid = new Soksak(value, settings);
    const first = value.cards[0].id;
    const rect = grid.rect.bind(grid);
    grid.rect = (id) => { const result = rect(id); return id === first ? { ...result, w: result.w + 1 } : result; };
    return grid;
  } }), /role independence/);
});

test("role comparison renames payer references before following a restored close", { timeout: 5000 }, async () => {
  const { assertRoleIndependence } = await import("../scripts/layout-equivalence.mjs");
  const grid = new Soksak(state, options);
  assert.equal(grid.split("upper", "x", { id: "child" }), "child");
  assert.equal(grid.toJSON().paidBy.child.to, "upper");
  let renamed = false;
  const result = assertRoleIndependence({ state: grid.toJSON(), options, operations: [{ method: "close", args: ["child"] }], create(value, settings) {
    if (!value.cards.some((card) => card.id === "upper")) {
      const [child, paid] = Object.entries(value.paidBy)[0];
      assert.notEqual(child, "child");
      assert.notEqual(paid.to, "upper");
      assert.ok(value.cards.some((card) => card.id === child));
      assert.ok(value.cards.some((card) => card.id === paid.to));
      renamed = true;
    }
    return new Soksak(value, settings);
  } });
  assert.ok(renamed);
  assert.deepEqual(result.outcomes, [true]);
  assert.equal(result.final.cards.find((card) => card.id === "left").rect.w, 180);
});

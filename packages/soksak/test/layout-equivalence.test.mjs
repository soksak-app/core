import assert from "node:assert/strict";
import test from "node:test";
import { Soksak } from "../dist/index.js";

const state = { root: { cut: "x", kids: [{ share: 0.3, node: { card: "left", fixed: true, width: 180 } }, { share: 0.7, node: { card: "upper", data: { id: "left" } } }] } };
const options = { width: 1600, height: 1200 };
const operations = [
  { method: "close", args: ["left"] },
  { method: "split", args: ["upper", "x", { id: "child" }] },
  { method: "close", args: ["child"] },
  { method: "setSize", args: ["left", "x", 220] },
];

/** The ids of the cards and the boxes of a stored tree. */
const idsOf = (node) => node.cut ? node.kids.flatMap((kid) => idsOf(kid.node)) : node.box ? [node.box, ...idsOf(node.inner)] : [node.card];

test("role comparison sends renamed inputs to the public layout API", { timeout: 5000 }, async () => {
  const { assertRoleIndependence } = await import("../scripts/layout-equivalence.mjs");
  const inputs = [];
  const result = assertRoleIndependence({ state, options, operations, create(value, settings) {
    inputs.push(structuredClone(value));
    return new Soksak(value, settings);
  } });
  assert.ok(inputs.some((value) => idsOf(value.root).every((id) => !["left", "upper"].includes(id))), "renamed ids reach the constructor");
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

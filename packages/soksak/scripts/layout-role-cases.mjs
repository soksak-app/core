import assert from "node:assert/strict";
import { Soksak } from "../dist/index.js";
import { assertSequence, random, runSequence } from "./layout-sequences.mjs";

export const layoutCaseSeeds = Array.from({ length: 21 }, (_, seed) => seed);

/** Build valid initial topology with public operations before varying its scale. */
export function makeLayoutCase(seed) {
  assert.ok(layoutCaseSeeds.includes(seed), "layout case seed must be in the declared 0..20 selection");
  const next = random(seed);
  const topology = ["columns", "rows", "mixed"][seed % 3];
  const count = Math.max(topology === "mixed" ? 3 : 2, 2 + seed % 7);
  const grid = new Soksak(undefined, { width: 4096, height: 3072, gap: 0, minSize: 1 });
  for (let index = 1; index < count; index++) {
    const axis = topology === "columns" ? "x" : topology === "rows" ? "y" : index % 2 ? "x" : "y";
    const card = [...grid.cards].sort((a, b) => {
      const ra = grid.rect(a.id), rb = grid.rect(b.id);
      return rb.w * rb.h - ra.w * ra.h;
    }).find((card) => grid.canSplit(card.id, axis));
    assert.ok(card, `seed ${seed}: topology generation cannot split ${axis}`);
    assert.equal(grid.splitToward(card.id, axis === "x" ? "right" : "bottom", { id: `pane-${index}` }), `pane-${index}`);
  }
  for (const [index, card] of grid.cards.entries()) {
    if ((index + seed) % 3 === 0) grid.setFixed(card.id, true);
    if ((index + seed) % 2 === 0) {
      const axis = seed % 2 ? "y" : "x";
      if ((axis === "x" ? card.c1 - card.c0 : card.r1 - card.r0) === 1) {
        assert.equal(grid.setSize(card.id, axis, 40 + Math.floor(next() * 160)), true);
      }
    }
  }
  const options = {
    width: [320, 640, 1730][Math.floor(seed / 3) % 3],
    height: [180, 900, 1440][Math.floor(seed / 7)],
    gap: [0, 17, 64][Math.floor(seed / 2) % 3],
    minSize: [24, 96, 160][seed % 3],
    snap: seed % 2 ? "off" : "merge", snapDistance: seed % 2 ? 3 : 29,
    grabSize: seed % 2 ? 7 : 23,
  };
  const initial = Soksak.from(grid.toJSON(), options);
  const state = initial.toJSON();
  const target = initial.cards[0].id;
  const operations = [
    { method: "setFixed", args: [target, true] },
    { method: "split", args: [target, "x", { id: "fixed-recovery" }] },
    { method: "setFixed", args: [target, false] },
    { method: "resize", args: [16384, 16384] },
    { method: "setSize", args: [target, "x", null] },
    { method: "setSize", args: [target, "y", null] },
    { method: "split", args: [target, "x", { id: "fixed-recovery" }] },
    { method: "close", args: ["fixed-recovery"] },
    { method: "resize", args: [1, 1] },
    { method: "split", args: [target, "x", { id: "size-recovery" }] },
    { method: "resize", args: [16384, 16384] },
    { method: "split", args: [target, "x", { id: "size-recovery" }] },
    { method: "close", args: ["size-recovery"] },
    { method: "resize", args: [options.width, options.height] },
  ];
  const prefix = assertSequence(runSequence(initial, { seed, profile: "constrained", operations }));
  const refusal = (step) => prefix.trace[step].outcome === "refused" && typeof prefix.trace[step].result?.throws === "string";
  assert.deepEqual(
    [prefix.trace[1].result, refusal(9), ...[6, 7, 11, 12].map((step) => prefix.trace[step].result)],
    [{ throws: `card ${target} is fixed and does not split` }, true, "fixed-recovery", true, "size-recovery", true],
    `seed ${seed}: refusal/recovery preconditions changed`,
  );
  const generated = assertSequence(runSequence(initial, { seed, steps: 20, profile: "constrained" }));
  operations.push(...generated.trace.map(({ method, args }) => ({ method, args })));
  return { seed, topology, state, options, operations };
}

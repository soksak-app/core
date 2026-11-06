import { Soksak } from "../dist/index.js";
import { assertInvariants, assertSequence, runSequence } from "../scripts/layout-sequences.mjs";

export const W = 1600;
export const H = 1200;

export function make(options = {}) {
  const grid = new Soksak(undefined, { width: W, height: H, ...options });
  return grid;
}

/** A sidebar on the left and two stacked cards on the right. */
export function three(options = {}) {
  const grid = new Soksak(
    {
      xs: [0, 0.28, 1],
      ys: [0, 0.52, 1],
      cards: [
        { id: "sidebar", c0: 0, c1: 1, r0: 0, r1: 2, fixed: true },
        { id: "upper", c0: 1, c1: 2, r0: 0, r1: 1 },
        { id: "lower", c0: 1, c1: 2, r0: 1, r1: 2 },
      ],
    },
    { width: W, height: H, ...options },
  );
  return grid;
}

/** The ordinary profile preserves the minimum and complete corridor. */
export function assertTiling(grid, label = "") {
  try { assertInvariants(grid, "ordinary"); }
  catch (error) { error.message = `${label}: ${error.message}`; throw error; }
}

export { random } from "../scripts/layout-sequences.mjs";

export function fuzz(grid, seed, steps) {
  assertSequence(runSequence(grid, { seed, steps, profile: "ordinary" }));
  return grid;
}

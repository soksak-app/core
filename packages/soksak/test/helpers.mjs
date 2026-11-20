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
    { root: { cut: "x", kids: [{ share: 0.28, node: { card: "sidebar", fixed: true } }, { share: 0.72, node: { cut: "y", kids: [{ share: 0.52, node: { card: "upper" } }, { share: 0.48, node: { card: "lower" } }] } }] } },
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

/**
 * Splits a card as a random build does: returns the new id, or null for a split that the grid refuses. A split throws its
 * refusal, and a build that walks many arrangements takes a refusal as one of its outcomes.
 */
export function trySplit(grid, ...args) {
  try {
    return grid.split(...args);
  } catch (error) {
    if (!/would be|does not split|is not a member|is a member/.test(error.message)) throw error;
    return null;
  }
}

/** As `trySplit`, for `splitToward`. */
export function trySplitToward(grid, ...args) {
  try {
    return grid.splitToward(...args);
  } catch (error) {
    if (!/would be|does not split|is not a member|is a member/.test(error.message)) throw error;
    return null;
  }
}

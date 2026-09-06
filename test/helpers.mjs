import assert from "node:assert/strict";

import { Soksak } from "../dist/index.js";

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
        { id: "terminal", c0: 1, c1: 2, r0: 0, r1: 1 },
        { id: "browser", c0: 1, c1: 2, r0: 1, r1: 2 },
      ],
    },
    { width: W, height: H, ...options },
  );
  return grid;
}

/**
 * The three properties every operation must preserve: cards never overlap, the
 * plane is covered with no gap left over, and the corridor between any two
 * neighbours is exactly `gap`.
 */
export function assertTiling(grid, label = "") {
  const rects = [...grid.rects().values()];
  let closest = Infinity;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
      const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
      assert.ok(dx > -0.01 || dy > -0.01, `${label}: cards overlap`);
      closest = Math.min(closest, Math.max(dx, dy));
    }
  }
  // The plane is covered exactly. Summing each card's *slot box* — line to line,
  // before the corridor is taken off — is the whole of it: the boxes tile the
  // plane by construction, whatever the gap and whatever lines nobody reads.
  // Measured slot to slot: a line no card references costs no gap.
  const X = (k) => grid.boundaryPos("x", k);
  const Y = (k) => grid.boundaryPos("y", k);
  const covered = grid.cards.reduce((n, c) => n + (X(c.c1) - X(c.c0)) * (Y(c.r1) - Y(c.r0)), 0);
  const plane = grid.width * grid.height;

  assert.ok(Math.abs(covered - plane) < 2, `${label}: plane not covered exactly (${covered - plane})`);
  if (rects.length > 1) {
    assert.ok(Math.abs(closest - grid.gap) < 0.5, `${label}: corridor is ${closest}, not ${grid.gap}`);
  }
  const smallest = Math.min(...rects.flatMap((r) => [r.w, r.h]));
  assert.ok(smallest >= grid.minSize - 0.6, `${label}: card shrank to ${smallest}`);
  assert.ok(grid.isSlicing(), `${label}: the arrangement is no longer slicing`);
}

/** Deterministic PRNG so a failure is always reproducible from its seed. */
export function random(seed) {
  let state = (seed * 2654435761 + 12345) & 0x7fffffff;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

export function fuzz(grid, seed, steps) {
  const next = random(seed);
  for (let i = 0; i < steps; i++) {
    const open = grid.cards.filter((p) => !p.fixed);
    if (!open.length) break;
    const card = open[Math.floor(next() * open.length)];
    const roll = next();
    if (roll < 0.5) {
      grid.split(card.id, next() < 0.5 ? "x" : "y");
    } else if (roll < 0.7) {
      grid.close(card.id);
    } else if (roll < 0.75) {
      grid.tidy();
    } else {
      const dividers = grid.dividers();
      if (dividers.length) {
        const d = dividers[Math.floor(next() * dividers.length)];
        grid.moveBoundary(d.axis, d.line, grid.boundaryPos(d.axis, d.line) + (next() - 0.5) * 0.4 * (d.axis === "x" ? W : H));
        grid.mergeCoincident(d.axis, d.line);
      }
    }
  }
  return grid;
}



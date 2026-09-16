import assert from "node:assert/strict";
import test from "node:test";

import { outline } from "../dist/index.js";
import { assertTiling, fuzz, three } from "./helpers.mjs";

test("splitting always leaves a slicing arrangement", () => {
  // Replacing one card with two can only build a slicing floorplan, and a
  // pinwheel — the shape that strands a card — is the canonical non-slicing one.
  for (let seed = 0; seed < 40; seed++) {
    const grid = three();
    for (let i = 0; i < 60; i++) {
      const open = grid.cards.filter((p) => !p.fixed);
      const card = open[Math.floor((i * 7 + seed) % open.length)];
      grid.split(card.id, (i + seed) % 2 ? "x" : "y");
    }
    assert.ok(grid.isSlicing(), `seed ${seed}`);
    const open = grid.cards.filter((p) => !p.fixed);
    for (const card of open) {
      assert.equal(grid.canClose(card.id), true, `seed ${seed}: ${card.id} is stuck`);
    }
  }
});

test("every invariant holds after split, close, drag and merge", () => {
  for (let seed = 0; seed < 60; seed++) {
    const grid = three();
    fuzz(grid, seed, 150);
    assertTiling(grid, `seed ${seed}`);
    const open = grid.cards.filter((p) => !p.fixed);
    if (open.length > 1) {
      for (const card of open) {
        assert.equal(grid.canClose(card.id), true, `seed ${seed}: ${card.id} is stuck`);
      }
    }
  }
});

test("every invariant holds at any gap, including zero", () => {
  for (const gap of [0, 2, 12, 24, 48]) {
    const grid = three({ gap });
    fuzz(grid, 3, 120);
    assertTiling(grid, `gap ${gap}`);
  }
});

test("the outline joins two cards at half the corridor", () => {
  for (let seed = 0; seed < 20; seed++) {
    const grid = three();
    fuzz(grid, seed, 60);
    const anchor = grid.rect("sidebar");
    for (const card of grid.cards) {
      if (card.fixed) continue;
      const rect = grid.rectOf(card);
      const shape = outline([anchor, rect], { pad: grid.gap / 2, radius: 14 + grid.gap / 2 });
      assert.equal(shape.sharp, 0, `seed ${seed}: ${card.id} has an unrounded corner`);
      const dx = Math.max(rect.x - (anchor.x + anchor.w), anchor.x - (rect.x + rect.w));
      const dy = Math.max(rect.y - (anchor.y + anchor.h), anchor.y - (rect.y + rect.h));
      const adjacent =
        (Math.abs(dx - grid.gap) < 0.5 && dy < -0.5) || (Math.abs(dy - grid.gap) < 0.5 && dx < -0.5);
      assert.equal(
        shape.loops.length,
        adjacent ? 1 : 2,
        `seed ${seed}: ${card.id} adjacent=${adjacent} loops=${shape.loops.length}`,
      );
    }
  }
});

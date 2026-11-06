import assert from "node:assert/strict";
import test from "node:test";

import { assertSequence, createProfile, runSequence } from "../scripts/layout-sequences.mjs";

test("every invariant holds after each structural change", { timeout: 30000 }, () => {
  const totals = { successful: 0, refused: 0 };
  for (let seed = 0; seed < 250; seed++) {
    const report = assertSequence(runSequence(createProfile("fixed"), { seed, steps: 60, profile: "fixed" }));
    for (const outcome of Object.keys(totals)) totals[outcome] += report.counts[outcome];
  }
  assert.ok(totals.successful > 0 && totals.refused > 0, JSON.stringify(totals));
});

test("a fixed card keeps its slots and its share of the other fixed cards", { timeout: 30000 }, () => {
  for (let seed = 0; seed < 40; seed++) {
    assertSequence(runSequence(createProfile("fixed"), {
      seed, steps: 25, profile: "fixed", methods: ["splitToward", "close", "move"],
      afterOperation(grid, entry, step) {
        for (const [id, want] of Object.entries({ left: 180, right: 200 })) {
          const card = grid.card(id);
          assert.ok(card, `seed ${seed} step ${step}: ${id} was removed`);
          assert.equal(card.width, want, `seed ${seed} step ${step}: ${id} was resized`);
          assert.equal(card.fixed, true, `seed ${seed} step ${step}: ${id} stopped being fixed`);
        }
      },
    }));
  }
});

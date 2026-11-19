// The touching judgement of the party cases (docs/spec/parties.md#commands, docs/spec/cases/layout/parties.json). Two cards touch when a side
// of one meets a side of the other across the gap. The layout cases state the judgement of each create step of two cards: a step with no
// error, or with the error of cards that do not touch, names the result of the touching check of its two cards.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as soksak from "../dist/index.js";

const cases = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/layout/parties.json", import.meta.url), "utf8")).cases;
const NOT_TOUCHING = "cards are not touching";

test("touches judges two cards as the party cases state them (docs/spec/parties.md#commands)", () => {
  let judged = 0;
  for (const kase of cases) {
    const cards = new Map(kase.state.cards.map((card) => [card.id, card]));
    for (const step of kase.steps) {
      if (step.call !== "core.party.create" || step.params.cards.length !== 2) continue;
      // Any other error belongs to another check of the create command, so the step does not judge touching.
      if (step.error !== undefined && !step.error.startsWith(NOT_TOUCHING)) continue;
      const [a, b] = step.params.cards.map((id) => cards.get(id));
      const expected = step.error === undefined;
      assert.equal(soksak.touches(a, b), expected, `${kase.name}: cards ${step.params.cards.join(", ")}`);
      judged += 1;
    }
  }
  assert.ok(judged >= 2, "the cases judge at least one touching and one not touching pair");
});

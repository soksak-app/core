// Runs the party cases of the layout model (docs/spec/cases/layout/parties.json, docs/spec/parties.md#commands) against the real party
// module. Each case builds a real Soksak grid from its state, registers the party commands through the real createRegistry, and runs its
// steps in order. A step with a returns member compares the reply; a step with an error member compares the message of the refusal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Soksak } from "soksak";
import { createRegistry } from "../exposure.js";
import { CHROME } from "../chrome-metrics.js";
import { THEMES, value } from "../settings.js";

const cases = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/layout/parties.json", import.meta.url), "utf8")).cases;

// The palette of the shown theme and mode, as core-exposure passes it to installParties.
const palette = () => THEMES.find((theme) => theme.name === value("theme"))[value("mode")];

/** The party record in the form of the case: the color token replaces the color value of the theme. */
function asCase(party) {
  const { color, ...rest } = party;
  return { ...rest, color_token: Object.keys(palette()).find((token) => palette()[token] === color) ?? null };
}

let instances = 0;
for (const item of cases) {
  test(`layout case: ${item.name} (docs/spec/parties.md#commands)`, { timeout: 10000 }, async () => {
    // Each case starts a new instance of the party module, which holds the parties of the window.
    const parties = await import(`../parties.js?case=${++instances}`);
    const cards = item.state.cards;
    // A case that states drawing gives the rail width of its theme, which the module draws with, the points of one grid line value and the grid gap.
    const drawing = item.drawing ?? null;
    if (drawing) assert.equal(drawing["theme-rail-w"], CHROME["theme-rail-w"], "the rail width of the case is the theme rail width");
    const unit = drawing?.unit ?? 1;
    const xs = [...new Set(cards.flatMap((card) => [card.c0, card.c1]))].sort((a, b) => a - b);
    const ys = [...new Set(cards.flatMap((card) => [card.r0, card.r1]))].sort((a, b) => a - b);
    const grid = new Soksak({ xs, ys, cards }, { gap: drawing?.gap ?? 0 });
    // The plane of a drawn case is unit points for each line value, the largest value on each axis (docs/spec/parties.md#drawing).
    if (drawing) grid.resize(unit * xs.at(-1), unit * ys.at(-1));
    const registry = createRegistry({ call: () => new Promise(() => {}), report: () => {} });
    registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
    parties.installParties({
      status: (name, read) => registry.status(name, read, () => () => {}),
      registry,
      notifyChange: () => {},
      grid: () => grid,
      plane: () => null,
      palette,
    });
    for (const step of item.steps) {
      const call = step.call.replace(/^core\.party\./, "");
      const run = () => registry.run(step.call, step.params);
      if ("error" in step) {
        await assert.rejects(run(), (error) => {
          assert.equal(String(error.message ?? error).replace(/^Error: /, ""), step.error, `${step.call}: refusal text`);
          return true;
        });
        continue;
      }
      const reply = await run();
      if (!("returns" in step)) continue;
      const { party, ...rest } = step.returns;
      // A card query names the holding party by its identifier, so its reply is compared as a whole.
      if (typeof party === "string") {
        assert.deepEqual(reply, step.returns, `${step.call} ${call}: reply`);
        continue;
      }
      // Each member that the returns name is compared with the reply: a member other than party is compared as a whole.
      assert.deepEqual(Object.fromEntries(Object.keys(rest).map((key) => [key, reply[key]])), rest, `${step.call} ${call}: members`);
      // The party record in the reply carries its outline; a case states only the fields of the record that it checks.
      if (party !== undefined) {
        const stated = Object.fromEntries(Object.keys(party).map((key) => [key, asCase(reply.party ?? {})[key]]));
        assert.deepEqual(stated, party, `${step.call} ${call}: party`);
      }
    }
  });
}

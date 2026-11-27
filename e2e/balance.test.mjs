// The command core.layout.balance gives the cards of a space a fair share of the plane, and keeps the arrangement.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const panes = (grid) => grid.cards.filter((card) => card.pane !== null);
const card = (grid, id) => grid.cards.find((item) => item.id === id);
const spread = (values) => Math.max(...values) - Math.min(...values);
/** The card of the grid that holds the tab surface. */
const cardOf = (grid, surface) => grid.cards.find((item) => item.tabs?.some((tab) => tab.tab === surface)).id;

for (const app of Object.values(APPS)) {
  test(`${app.name}: the auto-arrange button gives three over four cards a fair share`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const { surface, plugin } = await fresh(s);
    const first = cardOf(await s.get("core.grid"), surface);
    // The upper row is divided into 1/2, 1/4 and 1/4, the lower row into four times 1/4, and then one boundary of the lower row is moved to make the division uneven.
    const split = async (from, side) => (await s.run("core.card.split", { card: from, side, plugin })).card;
    const start = panes(await s.get("core.grid")).length;
    const lower = await split(first, "bottom");
    const upper = [first];
    upper.push(await split(upper[0], "right"));
    upper.push(await split(upper[1], "right"));
    const far = await split(lower, "right");
    const near = await split(lower, "right");
    const last = await split(far, "right");
    const below = [lower, near, far, last];
    await s.until("core.grid", (grid) => panes(grid).length === start + 6, "the six new cards did not appear");
    const grid = await s.get("core.grid");
    const line = card(grid, near).c1;
    await s.run("core.boundary.move", { axis: "x", line, position: grid.lines.x[line] + 60 });
    const before = await s.get("core.grid");
    assert.ok(spread(upper.map((id) => card(before, id).w)) > 10, `the upper row started even: ${JSON.stringify(before.cards)}`);
    assert.ok(spread(below.map((id) => card(before, id).w)) > 10, `the lower row started even: ${JSON.stringify(before.cards)}`);

    await s.run("core.layout.balance");
    const arranged = await s.until("core.grid", (grid) =>
      spread(upper.map((id) => card(grid, id).w)) <= 1 && spread(below.map((id) => card(grid, id).w)) <= 1,
      "core.layout.balance did not even the rows");
    assert.ok(Math.abs(card(arranged, upper[0]).h - card(arranged, below[0]).h) <= 1,
      `the rows do not halve the height: ${JSON.stringify(arranged.cards)}`);
    for (const id of [...upper, ...below]) {
      const was = card(before, id);
      const now = card(arranged, id);
      assert.equal(Math.sign(now.y - card(arranged, upper[0]).y), Math.sign(was.y - card(before, upper[0]).y),
        `${id} changed rows`);
    }
  });
}

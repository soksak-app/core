// The card auto-arrange button after the project list button, and its command (packages/soksak/docs/layout.md#balancing).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const panes = (grid) => grid.cards.filter((card) => card.pane !== null);
const card = (grid, id) => grid.cards.find((item) => item.id === id);
const spread = (values) => Math.max(...values) - Math.min(...values);

for (const app of Object.values(APPS)) {
  test(`${app.name}: the auto-arrange button gives three over four cards a fair share`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // The upper row is divided into 1/2, 1/4 and 1/4, the lower row into four times 1/4, and then one boundary of the lower row is moved to make the division uneven.
    const split = async (from, side) => (await s.run("core.card.split", { card: from, side, plugin: "browser" })).card;
    const start = panes(await s.get("core.grid")).length;
    const lower = await split("terminal", "bottom");
    const upper = ["terminal"];
    upper.push(await split(upper[0], "right"));
    upper.push(await split(upper[1], "right"));
    const far = await split(lower, "right");
    const near = await split(lower, "right");
    const last = await split(far, "right");
    const below = [lower, near, far, last];
    await s.until("core.grid", (grid) => panes(grid).length === start + 6, "the six new cards did not appear");
    const layout = await s.get("core.layout");
    const line = layout.state.cards.find((item) => item.id === near).c1;
    const grid = await s.get("core.grid");
    await s.run("core.boundary.move", { axis: "x", line, position: grid.lines.x[line] + 60 });
    const before = await s.get("core.grid");
    assert.ok(spread(upper.map((id) => card(before, id).w)) > 10, `the upper row started even: ${JSON.stringify(before.cards)}`);
    assert.ok(spread(below.map((id) => card(before, id).w)) > 10, `the lower row started even: ${JSON.stringify(before.cards)}`);

    // The button is in the right button row of the first row, directly after the project list button.
    const projects = await s.rect("core.chrome.projects");
    const button = await s.rect("core.chrome.balance");
    const after = projects.x + projects.width;
    assert.ok(button.x >= after && button.x - after <= 8 && Math.abs(button.y - projects.y) <= 0.5,
      `the auto-arrange button is not directly after the project library button: ${JSON.stringify({ projects, button })}`);

    await s.click((button.document?.x ?? 0) + button.x + button.width / 2, (button.document?.y ?? 0) + button.y + button.height / 2);
    const arranged = await s.until("core.grid", (grid) =>
      spread(upper.map((id) => card(grid, id).w)) <= 1 && spread(below.map((id) => card(grid, id).w)) <= 1,
      "the native click on the auto-arrange button did not even the rows");
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

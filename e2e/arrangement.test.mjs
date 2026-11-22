// The acceptance case of a whole arrangement (docs/spec/cli.md#planning-an-arrangement): from one card of a process plugin and one
// card of a document plugin, an agent asks for ten cards of the process plugin in two rows of five with equal widths and the document
// surface kept as an inactive tab. The case runs only the documented commands, at most 12, and judges the result by core.grid. The
// layout probe stands for the process plugin and the plain view probe, whose surface holds a document region, for the document plugin.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const DOCUMENT_PLUGIN = "probeplain";
const spread = (values) => Math.max(...values) - Math.min(...values);
/** The content cards of the grid: the window sidebars are cards of the grid without a pane. */
const panes = (grid) => grid.cards.filter((card) => card.pane !== null);

for (const app of Object.values(APPS)) {
  test(`${app.name}: a plan and its apply arrange ten cards in two rows of five and keep the document tab`, { timeout: 120000 },
    async (t) => {
      const s = await open(t, app);
      const { surface, plugin } = await fresh(s);
      // The start state: the start tab in one card and a tab of the document plugin in a card on its right, every other tab closed.
      const start = await s.run("core.layout.apply", { tree: { direction: "row", children: [
        { tabs: [{ tab: surface }] }, { tabs: [{ plugin: DOCUMENT_PLUGIN }] }] }, close: true });
      const document = start.tree.children[1].tabs[0].tab;
      await s.until("core.grid", (grid) => panes(grid).length === 2 && grid.groups.length === 0,
        "the start state of one process card and one document card did not appear");

      // The request, as the skill composes it: a plan of the tree and the apply of its tree, each a counted command.
      let commands = 0;
      const run = (name, params) => { commands += 1; return s.run(name, params); };
      const row = () => ({ direction: "row", children: Array.from({ length: 5 }, () => ({ tabs: [{ plugin }] })) });
      const plan = await run("core.layout.plan", { tree: { direction: "column", children: [row(), row()] } });
      assert.equal(plan.feasible, true, `the plan is not feasible: ${plan.reason}`);
      assert.deepEqual(plan.kept, [document], `the plan does not keep the document tab: ${JSON.stringify(plan.kept)}`);
      const applied = await run("core.layout.apply", { tree: plan.tree });
      assert.ok(commands <= 12, `the request took ${commands} commands`);

      const grid = await s.until("core.grid", (value) => panes(value).length === 10, "the ten cards did not appear");
      assert.equal(grid.groups.length, 0, `the arrangement holds group cards: ${JSON.stringify(grid.groups)}`);
      const rows = Object.values(Object.groupBy(panes(grid), (card) => Math.round(card.y)));
      assert.deepEqual(rows.map((cards) => cards.length), [5, 5], `the cards do not stand in two rows of five: ${JSON.stringify(panes(grid))}`);
      for (const cards of rows) {
        assert.ok(spread(cards.map((card) => card.w)) <= 1, `the widths of a row differ: ${JSON.stringify(cards.map((card) => card.w))}`);
      }
      assert.ok(Math.abs(rows[0][0].h - rows[1][0].h) <= 1, `the rows do not halve the height: ${JSON.stringify(grid.cards)}`);
      const holder = grid.cards.find((card) => card.tabs.some((tab) => tab.tab === document));
      assert.ok(holder, `the document tab ${document} is gone: ${JSON.stringify(grid.cards)}`);
      assert.notEqual(holder.active, document, "the document tab is the active tab of its card");
      assert.ok(grid.cards.some((card) => card.tabs.some((tab) => tab.tab === surface)), `the start tab ${surface} is gone`);
      assert.equal(applied.cards.length, 10, `the apply answers ${applied.cards.length} cards`);
    });
}

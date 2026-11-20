// The grid of raster probe cards of the click, scroll and layout redraw benchmarks: cards whose active tab is a tab of the raster
// probe fixture (e2e/raster-probe.mjs), a view whose native image region the persistent fixture sidecar draws, the composition of a
// terminal card. The rows of the grid are the first content cards of the start layout (fresh of e2e/fixture.mjs), which stand in
// one column, each of which gets a raster probe tab; each row is split toward the right through core.layout.open until it holds its
// columns, always at its widest card, so that no split reaches the minimum width of a card. The cleanup closes the cards and tabs
// that the grid added and moves the boundaries back to their start positions, so the layout is the start layout again.
import assert from "node:assert/strict";

import { RASTER, rasterReady } from "../../raster-probe.mjs";

const panes = (grid) => grid.cards.filter((card) => card.pane !== null);

/**
 * The rows of the start grid `grid` for a grid of `rows` rows: the first `rows` of its content cards from the top, which must stand
 * in one column (one left edge and one width). A start layout of fewer cards or of more columns is an error that names its cards.
 */
export function startRows(grid, rows) {
  const cards = panes(grid).sort((a, b) => a.y - b.y);
  const column = cards.every((card) => Math.abs(card.x - cards[0].x) <= 0.5 && Math.abs(card.w - cards[0].w) <= 0.5);
  if (cards.length < rows || !column) {
    throw new Error(`the start layout holds the content cards ${JSON.stringify(cards.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })))}, ` +
      `not ${rows} or more cards in one column, so it gives no rows of the grid`);
  }
  return cards.slice(0, rows).map((card) => card.id);
}

/** The widest of the cards `ids` in the grid `grid`, the first of them when two are equally wide. */
export function widestCard(grid, ids) {
  const width = (id) => grid.cards.find((card) => card.id === id).w;
  return ids.reduce((widest, id) => (width(id) > width(widest) + 0.5 ? id : widest));
}

/**
 * The boundary moves that bring the lines `now` (core.grid lines {x, y}) back to the lines `start`: for each axis whose lines are as
 * many as at the start, each line that stands more than half a point away. A different number of lines is an error, because the
 * cards of the grid were not all closed.
 */
export function boundaryMoves(start, now) {
  const moves = [];
  for (const axis of ["x", "y"]) {
    if (start[axis].length !== now[axis].length) throw new Error(`the grid has ${now[axis].length} ${axis} lines, not the ${start[axis].length} of the start`);
    start[axis].forEach((position, line) => {
      if (Math.abs(now[axis][line] - position) > 0.5) moves.push({ axis, line, position });
    });
  }
  return moves;
}

/**
 * Opens a grid of `rows` rows of `columns` raster probe cards in the window of `s` (see the top of the file) and waits until every
 * tab is ready (rasterReady). `balance` runs core.layout.balance after the splits. Returns the cards row by row as
 * `{card, surface}`; the cleanup of the check restores the start layout.
 */
export async function openRasterGrid(s, { rows, columns, balance }) {
  const start = await s.get("core.grid");
  const added = { cards: [], tabs: [] };
  s.cleanup(async () => {
    for (const card of [...added.cards].reverse()) {
      await s.run("core.card.close", { card });
      await s.until("core.grid", (grid) => !grid.cards.some((item) => item.id === card), `the benchmark card ${card} did not close`);
    }
    for (const tab of added.tabs) await s.run("core.tab.close", { tab });
    for (const move of boundaryMoves(start.lines, (await s.get("core.grid")).lines)) await s.run("core.boundary.move", move);
    await s.presented();
    const restored = await s.get("core.grid");
    assert.deepEqual(panes(restored).map((card) => card.id).sort(), panes(start).map((card) => card.id).sort(),
      "the cleanup of the benchmark did not restore the cards of the start layout");
  });
  let opened = 0;
  // Each tab has its own parameters, because core.layout.open selects a tab of the plugin with equal parameters.
  const open = async (params) => {
    const result = await s.run("core.layout.open", { ...params, plugin: RASTER, params: { benchmark: opened++ } });
    return result;
  };
  const grid = [];
  for (const card of startRows(start, rows)) {
    const { tab } = await open({ card });
    added.tabs.push(tab);
    const row = [{ card, surface: tab }];
    while (row.length < columns) {
      const widest = widestCard(await s.get("core.grid"), row.map((item) => item.card));
      const split = await open({ card: widest, side: "right" });
      added.cards.push(split.card);
      row.splice(row.findIndex((item) => item.card === widest) + 1, 0, { card: split.card, surface: split.tab });
    }
    grid.push(row);
  }
  const cards = grid.flat();
  await s.until("core.grid", (value) => cards.every(({ card, surface }) => value.cards.some((item) => item.id === card && item.active === surface)),
    `the ${cards.length} raster probe tabs did not become the active tabs of their cards`);
  if (balance) await s.run("core.layout.balance", {});
  for (const { surface } of cards) await rasterReady(s, surface);
  await s.presented();
  return grid;
}

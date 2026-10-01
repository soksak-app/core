import assert from "node:assert/strict";
import test from "node:test";
import { arrangeWindowSidebars, windowSidebarCards } from "../window-sidebars.js";

// 판의 열 이동 경계를 기록하는 가짜 판으로 고정 사이드바 배치를 실행한다.
for (const side of ["left", "right"]) test(`window ${side} sidebar retains its edge and width across plugin overrides`, () => {
  const units = [{ id: "alpha" }, { id: "beta" }];
  const links = [{ place: side, plugin: null, set: "general" }, ...units.map((unit) => ({ place: `window-${side}`, plugin: unit.id, set: unit.id }))];
  let cards = [{ id: "content", data: { tabs: [], activeId: null } }];
  const moves = [];
  const position = () => cards.forEach((card, index) => Object.assign(card, { c0: index, c1: index + 1 }));
  const grid = {
    get cards() { position(); return cards; },
    card: (id) => cards.find((card) => card.id === id),
    lines: () => Array.from({ length: cards.length + 1 }, (_, i) => i),
    canInsertAt: () => true,
    insertAt: (_, line, card) => { cards.splice(line, 0, { ...card, width: card.size }); position(); },
    setFixed: () => {},
    moveTo: (id, _, line) => {
      const index = cards.findIndex((card) => card.id === id);
      const [card] = cards.splice(index, 1);
      cards.splice(line === 0 ? 0 : cards.length, 0, card);
      moves.push(id);
      position();
      return true;
    },
  };
  const records = {};
  const arrange = (focus) => arrangeWindowSidebars(grid, windowSidebarCards(units, links, focus), records, 190,
    (shownSide) => shownSide === side, () => assert.fail("unexpected removal"));
  arrange("alpha");
  const outside = cards.filter((card) => card.id !== "content").map((card) => card.id);
  if (side === "right") outside.reverse();
  assert.deepEqual(outside, [side]);
  const sidebar = grid.card(side);
  sidebar.width = 230;
  const count = moves.length;
  arrange("beta");
  assert.equal(moves.length, count, "overrides must not move fixed columns");
  assert.equal(grid.card(side), sidebar);
  assert.equal(sidebar.width, 230);
  assert.equal(records[side].width, 230);
});

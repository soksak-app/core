import assert from "node:assert/strict";
import test from "node:test";

import { panelSurfaceRect, requireCleared, requireContentWidth, tabSwitchPair } from "../card-panel-checks.mjs";

test("panels left after clearing are rejected, including default ones", () => {
  assert.doesNotThrow(() => requireCleared({}));
  assert.throws(() => requireCleared({ top: { set: "space-list", collapsed: false } }), /panels remained after clearing: top/);
});

test("a tab switch fixture requires a tab of a different plugin", () => {
  const cards = [{ id: "a", active: "t1", tabs: [{ id: "t1", plugin: "layoutprobe" }] },
    { id: "b", active: "t2", tabs: [{ id: "t2", plugin: "probeplain" }] }];
  assert.deepEqual(tabSwitchPair(cards[0], cards), { original: cards[0].tabs[0], other: cards[1].tabs[0], from: "b" });
  assert.throws(() => tabSwitchPair(cards[0], [cards[0]]), /no tab of a plugin other than layoutprobe/);
});

test("a top or bottom panel must span the card's content column", () => {
  assert.doesNotThrow(() => requireContentWidth({ width: 758 }, { w: 760 }, 1, 6, "top"));
  const sidebars = { left: { collapsed: false, shownSize: 190 }, right: { collapsed: true, shownSize: null } };
  assert.doesNotThrow(() => requireContentWidth({ width: 562 }, { w: 760, sidebars }, 1, 6, "bottom"));
  assert.throws(() => requireContentWidth({ width: 758 }, { w: 760, sidebars }, 1, 6, "bottom"),
    /bottom panel is 758 wide, not the card's content column width 562/);
});

test("the native surface leaves the shown size of each open side and the divider of each folded side", () => {
  // Measured on the start card of the layoutprobe fixture: the card is 315.6 points high, so the top side stored at 190 is shown at
  // 163.5, which leaves the 96-point layout minimum to the content (315.6 - 2 - 32 - 22 - 96 = 163.6, on the 2x device pixel grid).
  // The hosts applied y 634 and h 96, the device pixel grid of 83 + 354.4 + 1 + 32 + 163.5 = 633.9 and 315.6 - 56 - 163.5 = 96.1.
  const open = { collapsed: false, size: 190, shownSize: 190 };
  const card = { x: 202, y: 354.4, w: 762, h: 315.6, sidebars: { left: open, right: open, top: { collapsed: false, size: 190, shownSize: 163.5 } } };
  const metrics = { border: 1, head: 32, foot: 22, divider: 6 };
  const rect = panelSurfaceRect({ x: 7, y: 83 }, card, metrics);
  assert.deepEqual(Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, Math.round(value * 10) / 10])),
    { x: 400, y: 633.9, w: 380, h: 96.1 });
  const folded = { ...card, sidebars: { left: open, bottom: { collapsed: true, size: 190, shownSize: null } } };
  assert.deepEqual(panelSurfaceRect({ x: 0, y: 0 }, folded, metrics), { x: 393, y: 387.4, w: 570, h: 315.6 - 2 - 32 - 22 - 6 });
});


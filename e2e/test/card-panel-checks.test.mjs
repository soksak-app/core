import assert from "node:assert/strict";
import test from "node:test";

import { missingPoses, requireCleared, requireFullWidth, tabSwitchPair } from "../card-panel-checks.mjs";

test("a pose without a recorded frame within two display frames is missing", () => {
  const frames = [{ time: 100, edges: [10] }, { time: 130, edges: [20] }, { time: 200, edges: [30] }];
  const poses = [{ displayed: 99, at: 10 }, { displayed: 120, at: 20 }, { displayed: 150, at: 30 }];
  assert.deepEqual(missingPoses(frames, poses, 60), [{ displayed: 150, at: 30 }]);
  assert.deepEqual(missingPoses(frames, poses.slice(0, 2), 60), []);
});

test("panels left after clearing are rejected, including default ones", () => {
  assert.doesNotThrow(() => requireCleared({}));
  assert.throws(() => requireCleared({ top: { set: "space-list", collapsed: false } }), /panels remained after clearing: top/);
});

test("a tab switch fixture requires a tab of a different plugin", () => {
  const cards = [{ id: "a", active: "t1", tabs: [{ id: "t1", plugin: "terminal" }] },
    { id: "b", active: "t2", tabs: [{ id: "t2", plugin: "browser" }] }];
  assert.deepEqual(tabSwitchPair(cards[0], cards), { original: cards[0].tabs[0], other: cards[1].tabs[0], from: "b" });
  assert.throws(() => tabSwitchPair(cards[0], [cards[0]]), /no tab of a plugin other than terminal/);
});

test("a top or bottom panel must span the card's inner width", () => {
  assert.doesNotThrow(() => requireFullWidth({ width: 758 }, { w: 760 }, 1, "top"));
  assert.throws(() => requireFullWidth({ width: 568 }, { w: 760 }, 1, "top"), /top panel is 568 wide, not the card's inner width 758/);
});

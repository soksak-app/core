import assert from "node:assert/strict";
import test from "node:test";

import { alignmentDelta } from "../alignment.mjs";

const initial = { contentLeft: 1, contentRight: 1, sidebar: 13, rail: 6 };

test("a terminal raster that lags inside its card on the right is aligned", () => {
  // While the size changes, the terminal shows the raster of the earlier size attached to the left. Only the right inner margin grows; the raster does not
  // leave the card.
  assert.equal(alignmentDelta(initial, { ...initial, contentRight: 131 }), 0);
});

test("content that crosses the card edge or moves its left edge is not aligned", () => {
  assert.equal(alignmentDelta(initial, { ...initial, contentRight: -3 }), 4);
  assert.equal(alignmentDelta(initial, { ...initial, contentLeft: 5 }), 4);
  assert.equal(alignmentDelta(initial, { ...initial, rail: 9 }), 3);
});

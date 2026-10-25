import assert from "node:assert/strict";
import test from "node:test";

import { alignmentDelta } from "../alignment.mjs";

const initial = { contentLeft: 1, contentRight: 1, sidebar: 13, rail: 6 };

test("a terminal raster that leaves a growing right inset is misaligned", { timeout: 1000 }, () => {
  // A raster inside the card still violates same-frame geometry when its right edge stays at the earlier size.
  assert.equal(alignmentDelta(initial, { ...initial, contentRight: 131 }), 130);
});

test("content that crosses the card edge or moves its left edge is not aligned", { timeout: 1000 }, () => {
  assert.equal(alignmentDelta(initial, { ...initial, contentRight: -3 }), 4);
  assert.equal(alignmentDelta(initial, { ...initial, contentLeft: 5 }), 4);
  assert.equal(alignmentDelta(initial, { ...initial, rail: 9 }), 3);
});

import assert from "node:assert/strict";
import test from "node:test";

import { presentsFrame } from "../region-raster.mjs";

const region = (frame, presented) => ({ visible: true, frame: { x: 726, y: 116, ...frame }, presented });

test("a raster of the frame size in device pixels presents the frame at scale 2", { timeout: 1000 }, () => {
  // The hosted window run measured a 488 x 546 pixel raster for a 244 x 273 point frame on a window at scale 2.
  assert.equal(presentsFrame(region({ width: 244, height: 273 }, { width: 488, height: 546, scale: 2 }), 2), true);
});

test("a raster of the frame size presents the frame at scale 1", { timeout: 1000 }, () => {
  assert.equal(presentsFrame(region({ width: 244, height: 273 }, { width: 244, height: 273, scale: 1 }), 1), true);
});

test("a raster of the earlier frame size does not present the frame", { timeout: 1000 }, () => {
  // Before the balance the narrowed card had a frame of 163 points, so its raster had 326 device pixels at scale 2.
  assert.equal(presentsFrame(region({ width: 244, height: 273 }, { width: 326, height: 546, scale: 2 }), 2), false);
  assert.equal(presentsFrame(region({ width: 244, height: 273 }, { width: 244, height: 273, scale: 1 }), 2), false);
});

test("a hidden or unpresented region does not present the frame", { timeout: 1000 }, () => {
  assert.equal(presentsFrame({ ...region({ width: 244, height: 273 }, { width: 488, height: 546, scale: 2 }), visible: false }, 2), false);
  assert.equal(presentsFrame(region({ width: 244, height: 273 }, null), 2), false);
  assert.equal(presentsFrame(undefined, 2), false);
});

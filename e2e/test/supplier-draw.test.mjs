import assert from "node:assert/strict";
import test from "node:test";
import { supplierDrawDurations } from "../supplier-draw.mjs";

const record = (fields) => ({ event: "sidecar.vt.frame", fields });
const drawn = (draw_us) => record({ reason: "resize", draw_us, raster: "100x100", image: 1 });

test("supplier draw durations classify screen records without a raster", { timeout: 1000 }, () => {
  assert.deepEqual(supplierDrawDurations([
    drawn(2000), record({ reason: "screen" }), drawn(1750),
  ]), { draw: [1.75, 2], nonDraw: 1 });
});

test("supplier draw durations require at least one raster draw", { timeout: 1000 }, () => {
  assert.throws(() => supplierDrawDurations([record({ reason: "screen" })]), /supplier.*draw/);
});

test("supplier draw durations reject malformed or partial raster metrics", { timeout: 1000 }, () => {
  for (const value of [-1, NaN, Infinity, "1750", null, undefined]) {
    assert.throws(() => supplierDrawDurations([drawn(value)]), /supplier.*draw/);
  }
  assert.throws(() => supplierDrawDurations([record({ reason: "resize", raster: "100x100", image: 1 })]), /supplier.*draw/);
});

test("supplier draw durations retain valid zero and fractional milliseconds", { timeout: 1000 }, () => {
  assert.deepEqual(supplierDrawDurations([drawn(1), drawn(0)]), { draw: [0, .001], nonDraw: 0 });
});

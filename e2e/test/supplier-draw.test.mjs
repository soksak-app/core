import assert from "node:assert/strict";
import test from "node:test";
import { supplierDrawDurations } from "../supplier-draw.mjs";

const record = (fields) => ({ event: "sidecar.rasterprobe.frame", fields });
const drawn = (draw_us) => record({ raster: 4, surface: 7, draw_us });

test("supplier draw durations read the paint time of every frame record of the fixture sidecar", { timeout: 1000 }, () => {
  assert.deepEqual(supplierDrawDurations([drawn(2000), drawn(1750)]), { draw: [1.75, 2] });
});

test("supplier draw durations require at least one raster draw", { timeout: 1000 }, () => {
  assert.throws(() => supplierDrawDurations([]), /supplier.*draw/);
});

test("supplier draw durations reject malformed or partial raster metrics and other records", { timeout: 1000 }, () => {
  for (const value of [-1, NaN, Infinity, "1750", null, undefined]) {
    assert.throws(() => supplierDrawDurations([drawn(value)]), /supplier.*draw/);
  }
  assert.throws(() => supplierDrawDurations([record({ raster: 4, draw_us: 3 })]), /supplier.*draw/);
  assert.throws(() => supplierDrawDurations([{ event: "sidecar.rasterprobe.request", fields: { raster: 4, surface: 7, draw_us: 3 } }]), /supplier.*draw/);
});

test("supplier draw durations retain valid zero and fractional milliseconds", { timeout: 1000 }, () => {
  assert.deepEqual(supplierDrawDurations([drawn(1), drawn(0)]), { draw: [0, .001] });
});

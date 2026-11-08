import assert from "node:assert/strict";

/**
 * Measures the draw durations of the supplier of an image region from its frame records: the fake sidecar of the raster probe writes
 * `sidecar.rasterprobe.frame` for each frame it sends, with its raster, its transfer image and the time that painting it took
 * (`draw_us`). Returns the durations in milliseconds, sorted.
 */
export function supplierDrawDurations(events) {
  assert.ok(Array.isArray(events), "supplier draw records are not an array");
  const draw = [];
  for (const event of events) {
    const fields = event?.fields;
    assert.ok(event?.event === "sidecar.rasterprobe.frame" && fields && typeof fields === "object" && !Array.isArray(fields),
      "supplier draw record has invalid event fields");
    assert.ok(Number.isSafeInteger(fields.raster) && fields.raster > 0
      && Number.isSafeInteger(fields.surface) && fields.surface > 0
      && typeof fields.draw_us === "number" && Number.isFinite(fields.draw_us) && fields.draw_us >= 0,
    "supplier raster draw has missing or invalid duration or raster metrics");
    draw.push(fields.draw_us / 1000);
  }
  assert.ok(draw.length > 0, "the drag has no valid supplier frame draw durations");
  draw.sort((a, b) => a - b);
  return { draw };
}

import assert from "node:assert/strict";

/** Measures supplier draw records; screen-only records have no raster duration. */
export function supplierDrawDurations(events) {
  assert.ok(Array.isArray(events), "supplier draw records are not an array");
  const draw = [];
  let nonDraw = 0;
  for (const event of events) {
    const fields = event?.fields;
    assert.ok(event?.event === "sidecar.vt.frame" && fields && typeof fields === "object"
      && !Array.isArray(fields) && typeof fields.reason === "string" && fields.reason.length > 0,
    "supplier draw record has invalid event fields");
    if (!["raster", "image", "draw_us"].some((name) => Object.hasOwn(fields, name))) {
      nonDraw++;
      continue;
    }
    assert.ok(typeof fields.raster === "string" && fields.raster.length > 0
      && Number.isSafeInteger(fields.image) && fields.image > 0
      && Number.isFinite(fields.draw_us) && fields.draw_us >= 0,
    "supplier raster draw has missing or invalid duration or raster metrics");
    draw.push(fields.draw_us / 1000);
  }
  assert.ok(draw.length > 0, "the drag has no valid supplier frame draw durations");
  draw.sort((a, b) => a - b);
  return { draw, nonDraw };
}

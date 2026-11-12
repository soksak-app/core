// Checks that a native view stands on its slot at each slot of its card: the frame that the host applied to each raster probe view
// lies on the device pixels of the frame that the page declared, at the first layout and after each move of a line of its card.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { ensureRasters, RASTER } from "./raster-probe.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a native view stands on the device pixels of its declared slot at each slot`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await s.run("host.window.resize", { width: 1200, height: 760 });
    const rasters = await ensureRasters(s, 2);

    const look = async (slot) => {
      const { scale } = await s.get("host.window");
      const onDevicePixels = (a, b) => Math.round(a * scale) === Math.round(b * scale);
      await s.until("core.surfaces", (list) => list.filter((x) => x.visible && x.plugin === RASTER).every(({ declared: d, applied: a }) => a &&
        onDevicePixels(a.x, d.x) && onDevicePixels(a.y, d.y) && onDevicePixels(a.x + a.w, d.x + d.w) && onDevicePixels(a.y + a.h, d.y + d.h)),
      `the views did not stand on their slots at ${slot}`);
    };

    await look("the first layout");
    const first = (await s.get("core.grid")).cards.find((card) => card.tabs?.some((tab) => tab.id === rasters[0].surface));
    assert.ok(first, `no card holds the raster probe ${rasters[0].surface}`);
    const own = (await s.get("core.layout")).state.cards.find((card) => card.id === first.id);
    const inner = (lines, first, last) => (last < lines.length - 1 ? last : first);
    for (const [axis, offset] of [["x", -17.4], ["x", -33.75], ["y", -21.3], ["y", -38.25]]) {
      const lines = (await s.get("core.grid")).lines[axis];
      const line = axis === "x" ? inner(lines, own.c0, own.c1) : inner(lines, own.r0, own.r1);
      const position = lines[line] + offset;
      await s.run("core.boundary.move", { axis, line, position });
      await s.until("core.grid", (grid) => Math.abs(grid.lines[axis][line] - position) < 1, `the line ${axis} ${line} did not move to ${position}`);
      await look(`${axis} ${line} at ${position}`);
    }
  });
}

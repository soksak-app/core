// Checks in a still that a native view touches the lines of its card. A comparison of rectangles cannot state this: a view can stand
// where it declared and a row of the card can still lie between it and its line, or inside its slot. The native views are raster
// probes, whose image regions fill the view in one measured color.
import assert from "node:assert/strict";
import { rmdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import { APPS, holdCovered, open } from "@soksak/window-check/app.mjs";
import { readPng } from "@soksak/window-check/png.mjs";
import { viewEdgeFaults } from "@soksak/window-check/view-edges.mjs";
import { fresh } from "./fixture.mjs";
import { ensureRasters, MEASURED_HEX, presentedFrame, RASTER, setMeasuredColor } from "./raster-probe.mjs";

const VIEW = MEASURED_HEX.slice(1);

for (const app of Object.values(APPS)) {
  test(`${app.name}: a native view touches the lines of its card at each slot`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await s.run("core.settings.theme", { name: "midnight", mode: "dark" });
    const theme = (await s.get("core.themes")).find((item) => item.name === "midnight").dark;
    const colors = { view: VIEW, lines: [theme.edge.slice(1), theme.focus.slice(1)] };
    await s.run("host.window.resize", { width: 1200, height: 760 });
    // An inactive application shows its window behind the frontmost window, where its image regions do not draw. The still reads
    // the pixels of the window wherever it is in the window order (docs/spec/native-surfaces.md#image-regions).
    s.cleanup(await holdCovered(s));
    const shown = async (when) => t.diagnostic(`occluded ${when}: ${(await s.get("host.window")).occluded}`);
    await shown("at the start");
    const rasters = await ensureRasters(s, 2);
    for (const { surface } of rasters) await setMeasuredColor(s, surface);

    const faults = [];
    const look = async (slot) => {
      const { scale } = await s.get("host.window");
      const onDevicePixels = (a, b) => Math.round(a * scale) === Math.round(b * scale);
      const placed = await s.until("core.surfaces", (list) => list.filter((x) => x.visible && x.plugin === RASTER).every(({ declared: d, applied: a }) => a &&
        onDevicePixels(a.x, d.x) && onDevicePixels(a.y, d.y) && onDevicePixels(a.x + a.w, d.x + d.w) && onDevicePixels(a.y + a.h, d.y + d.h)),
      `the views did not stand on their slots at ${slot}`);
      for (const { surface } of rasters) await presentedFrame(s, surface, (frame) => frame.color === MEASURED_HEX, `a frame in ${MEASURED_HEX}`);
      await s.presented();
      const { path } = await s.request("diagnostics.capture.still", {});
      s.cleanup(() => rmdirSync(dirname(path)));
      s.cleanup(() => unlinkSync(path));
      const image = readPng(path);
      for (const { surface, declared, visible, plugin } of placed) {
        if (!visible || plugin !== RASTER) continue;
        for (const fault of viewEdgeFaults(image, declared, scale, colors)) {
          faults.push(`${slot} ${surface} ${declared.x},${declared.y} ${declared.w}x${declared.h} ${fault}`);
        }
      }
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
    await shown("at the end");
    assert.deepEqual(faults, []);
  });
}

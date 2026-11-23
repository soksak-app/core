// After a reload of the main page, a status read that names a surface reads the state of that surface, and each view keeps the
// session of its own surface (docs/spec/exposure.md, the surface member of a request). The vehicle is the raster probe: each
// tab has its own sidecar session, which rasterprobe.session names, and paints the color that rasterprobe.color gave its surface.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { closeRasterTabs, ensureRasters, presentedFrame } from "./raster-probe.mjs";

const COLORS = ["#ff0000", "#00ff00", "#0000ff"];

for (const app of Object.values(APPS)) {
  test(`${app.name}: each surface reads and draws its own session after a reload of the main page`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { settings: { memorySaver: false } });
    const rasters = await ensureRasters(s, COLORS.length);
    const before = new Map();
    for (const [index, { surface }] of rasters.entries()) {
      await s.run("rasterprobe.color", { color: COLORS[index] }, surface);
      await presentedFrame(s, surface, (frame) => frame.color === COLORS[index], `the color ${COLORS[index]} of ${surface}`);
      before.set(surface, { session: (await s.get("rasterprobe.session", surface)).session, color: COLORS[index] });
    }
    assert.equal(new Set([...before.values()].map(({ session }) => session)).size, COLORS.length, "the tabs share a session");

    const oldDocument = (await s.get("core.window.workbench")).start;
    await s.run("host.window.reload");
    await s.until("core.window.workbench", (value) => value.start !== oldDocument && value.readyState === "complete",
      "the workbench did not start again");

    for (const [surface, { session, color }] of before) {
      await s.until("core.surfaces", (items) => items.some((item) => item.surface === surface
        && item.exposes.includes("status rasterprobe.session")), `${surface} did not register rasterprobe.session after the reload`);
      const read = await s.get("rasterprobe.session", surface);
      assert.equal(read.session, session, `the status of ${surface} names the session of another surface`);
      const frame = await presentedFrame(s, surface, () => true, `a frame of ${surface}`);
      assert.equal(frame.color, color, `${surface} draws the color of another surface`);
    }
    await closeRasterTabs(s);
  });
}

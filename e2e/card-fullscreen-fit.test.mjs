// An image region has the size of its card in the same presentation that ends the full screen of the card: the grid of the frame
// that the sidecar of the raster probe draws (`rasterprobe.frame`) returns to the rows and columns of the small card and the region
// has the geometry of the card.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { addRasterTab, presentedFrame } from "./raster-probe.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: an image region fits its card in the presentation that ends the full screen`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const { card: id, surface } = await addRasterTab(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.id === id);
    await s.presented();
    const small = (await presentedFrame(s, surface)).grid;
    const smallRegion = (await s.get("core.surfaces")).find((item) => item.surface === surface).applied;
    const enter = await s.rect("core.card.fullscreen", card.pane);
    await s.click(enter.x + enter.width / 2, enter.y + enter.height / 2);
    await s.until("core.grid", (state) => state.fullscreen === card.id, "the icon did not start the full screen");
    await s.presented();
    await s.until("rasterprobe.frame", (frame) => frame.grid.cols > small.cols && frame.grid.rows >= small.rows,
      `the image region did not grow in the full screen from ${small.cols}x${small.rows}`, { surface });
    // The person presses the icon of the card, as in the report.
    const control = await s.rect("core.card.fullscreen", card.pane);
    await s.click(control.x + control.width / 2, control.y + control.height / 2);
    await s.until("core.grid", (state) => state.fullscreen === null, "the icon did not end the full screen");
    await s.presented();
    // The size is read once in the presentation that ended the full screen; no later event is awaited.
    const region = (await s.get("core.surfaces")).find((item) => item.surface === surface).applied;
    const restored = (await s.get("rasterprobe.frame", surface)).grid;
    assert.deepEqual(region, smallRegion, `the region did not return to the geometry of the card: ${JSON.stringify({ region, smallRegion })}`);
    assert.deepEqual([restored.cols, restored.rows], [small.cols, small.rows],
      `the image region kept its full-screen size after the full screen ended: ${JSON.stringify({ small: [small.cols, small.rows], restored: [restored.cols, restored.rows] })}`);
  });
}

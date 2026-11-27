// Checks that each view draws its current frame after a restart without input (F999). `core.plugins.apply` reloads the workbench
// page with no change pending (packages/workbench/plugin-apply.js), and each raster probe view of the window must present a frame
// of a new attachment generation with no click, focus change, resize or command. The views are the raster probe fixture
// `rasterprobe` (e2e/raster-probe.mjs), whose image regions the fixture sidecar draws; the window keeps its drawing while it is covered
// (rasterReady), so the window is on screen and not key as the restart runs.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { allRows, tailOf } from "@soksak/window-check/chains.mjs";
import { fresh } from "./fixture.mjs";
import { closeRasterTabs, ensureRasters, presentedFrame, RASTER_ENTRIES, REGION } from "./raster-probe.mjs";


const presentedOf = (host, surface) => host.regions.find((item) => item.surface === surface && item.name === REGION);

/**
 * Waits until the event log holds a `workbench.start` of a document other than `oldStart` after `since`. The page that restarts
 * records its start before its statuses can be read, while the window still reports the ready state of the earlier page.
 */
async function waitForReplacementStart(s, since, oldStart) {
  for (;;) {
    const previous = await s.get("host.log");
    const rows = await allRows(s, { channel: "all", since });
    if (rows.some(({ event }) => event.event === "workbench.start" && event.start !== oldStart)) return;
    await s.until("host.log", (value) => value.notices > previous.notices, "the restarted page did not record workbench.start");
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: after core.plugins.apply each view presents a new frame without input`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { settings: { memorySaver: false } });
    const rasters = await ensureRasters(s, 3);
    assert.equal(rasters.length, 3, `expected 3 visible raster probe views, got ${rasters.length}`);
    for (const { surface } of rasters) await presentedFrame(s, surface, () => true, "a frame before the restart");
    const before = new Map();
    for (const { surface } of rasters) before.set(surface, presentedOf(await s.get("host.window"), surface).presented.generation);

    const oldStart = (await s.get("core.window.workbench")).start;
    const since = await tailOf(s);
    assert.deepEqual(await s.run("core.plugins.apply", {}), { reloaded: true }, "core.plugins.apply did not reload the page");
    await waitForReplacementStart(s, since, oldStart);
    await s.until("host.windows", (list) => list.some((window) => window.window === s.window && window.ready),
      "the restarted main page did not report ready");
    await s.until("core.window.workbench", (workbench) => workbench.start !== oldStart && workbench.readyState === "complete",
      "the restarted workbench did not start");

    // Every view draws its current frame: its region is visible, presents an attachment of a new generation, and presents the last
    // frame that its sidecar sent after the restart. No input is sent from here to the end of the check.
    for (const { surface } of rasters) {
      await s.registered(surface, RASTER_ENTRIES, `the restarted raster probe ${surface} did not register its entries`);
      const frame = await presentedFrame(s, surface, () => true, "a frame after the restart");
      const region = await s.until("host.window", (host) => {
        const item = presentedOf(host, surface);
        return item?.visible === true && item.presented !== null && item.presented.generation > before.get(surface);
      }, `the raster probe ${surface} did not present a new attachment generation after the restart`);
      assert.ok(frame, `no frame for ${surface} after the restart`);
      assert.ok(region, `the region of ${surface} is not visible after the restart`);
    }
    await closeRasterTabs(s);
  });
}

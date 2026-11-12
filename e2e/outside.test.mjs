// Records two round trips that move 250pt in 400ms over a raster probe in the card to the right of the left fixed sidebar and
// checks the frames that its fake sidecar supplies during the drag. The recording is the evidence of the drag.
import assert from "node:assert/strict";
import { availableParallelism, loadavg } from "node:os";
import test from "node:test";

import { APPS, drag, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh, probeListSections, reading } from "./fixture.mjs";
import { CHECK_SET } from "@soksak/window-check/start.mjs";
import { currentEventOffsets, readEvents, untilEventLines } from "@soksak/window-check/event-log.mjs";
import { supplierDrawDurations } from "./supplier-draw.mjs";
import { addRasterTabAt, RASTER } from "./raster-probe.mjs";
import { transactionCadence } from "@soksak/window-check/drag-measurement.mjs";

// Vertical line 1 is the boundary between the left fixed sidebar and the first card of the middle column. Dragging it moves the left
// edge of that card.
const PLAN = { axis: "x", line: 1, dx: 250, dy: 0, ms: 400, times: 2 };

/** Adds a raster probe tab to the first card of the middle column, whose left edge is line 1, and returns `{card, surface}`. */
const rasterInFirstCard = (s) => addRasterTabAt(s, 1, 0);

for (const app of Object.values(APPS)) {
  test(`${app.name}: a divider drag beside the sidebar rail draws the supplier frames of its raster probe`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { log: { frame: "debug" }, reads: ["sidecar.rasterprobe.frame"] });
    const raster = await rasterInFirstCard(s);
    // The right override of the raster probe ties the fixed sidebar and the rail to the raster probe card. The environment of an
    // application declares the sidebar sets in place of the sets of the plugins, so the check stores a common set of the list
    // sections of the layout probe and links it; keepCommonSettings restores both when the check ends.
    await keepCommonSettings(s);
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: [...sets.filter((item) => item.id !== CHECK_SET),
      { id: CHECK_SET, title: "검사", sections: probeListSections(), layout: "list" }] }, scope: "common" });
    await s.run("core.settings.link", { place: "window-right", plugin: RASTER, set: CHECK_SET, scope: "common" });
    await s.until("core.rail", (rail) => rail.groups.length === 1, "the raster probe override drew no rail");
    const offsets = currentEventOffsets(app.configDir);
    const run = await drag(s, PLAN, { capture: true });
    t.diagnostic(`page handling per step (ms): ${JSON.stringify(run.handled)}`);
    // A drag whose recording failed answers without the display time of its last layout, which the next presentation gives.
    const displayed = run.displayed ?? (await s.presented()).displayed;
    await s.flushLog();
    let supplierFrames = [];
    await untilEventLines(app.configDir, offsets, () => {
      supplierFrames = readEvents(app.configDir, offsets).events.filter((event) =>
        event.event === "sidecar.rasterprobe.frame" && event.surface === raster.surface
        && event.mono_ns / 1e6 >= run.ticks[0] && event.mono_ns / 1e6 <= displayed);
      return supplierFrames.length > 0;
    }, { ...reading(app, ["sidecar.rasterprobe.frame"]), ended: s.client.ended });
    const { draw } = supplierDrawDurations(supplierFrames);
    t.diagnostic(`supplier frame draw (ms): count ${draw.length}, median ${draw[Math.floor(draw.length / 2)].toFixed(3)}, ` +
      `p90 ${draw[Math.floor(draw.length * .9)].toFixed(3)}, max ${draw.at(-1).toFixed(3)}`);
    // The transaction period is reported before the delay judgment. Even if the judgment fails, that period stays in the output (F92).
    t.diagnostic(`transaction cadence (ms): ${JSON.stringify(transactionCadence(run.layouts))}`);
    t.diagnostic(`system load ${JSON.stringify(loadavg())}, processors ${availableParallelism()}; recording ${run.frameDir}`);
  });
}

// The check compares the size that the surface document of the raster probe reports (core.surface.document) with the native position
// that the host placed (host.window), which pixels alone cannot separate from the width of the document.
async function assertDocumentFillsFrame(s, surface, label) {
  await s.presented();
  const frame = (await s.get("host.window")).surfaces.find((item) => item.id === surface)?.frame;
  assert.ok(frame?.width > 0, `${label}: the surface ${surface} has no native frame`);
  const { body, viewport } = await s.get("core.surface.document", surface);
  for (const [name, size] of [["body", body], ["viewport", viewport]]) {
    assert.ok(Math.abs(size.width - frame.width) <= 0.5 && Math.abs(size.height - frame.height) <= 0.5,
      `${label}: the surface document ${name} is ${size.width}×${size.height} in a native frame of ${frame.width}×${frame.height}`);
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: an image region view document fills its native frame before and after a divider drag`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const { surface } = await rasterInFirstCard(s);
    await assertDocumentFillsFrame(s, surface, "at rest");
    await drag(s, { axis: "x", line: 1, dx: 250, dy: 0, ms: 96, times: 1 });
    await assertDocumentFillsFrame(s, surface, "after the drag");
  });
}

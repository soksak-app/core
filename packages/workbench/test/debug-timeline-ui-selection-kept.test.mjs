import assert from "node:assert/strict";
import test from "node:test";
import { open } from "./support/debug-timeline.mjs";

test("a selection stays on its row when the filter changes and when older rows come in front", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-selection-kept");
  try {
    await ui.showDebugTimeline();
    ui.selectDebugRow(499, true);
    await ui.olderDebugTimeline();
    const picks = [...document.querySelectorAll('[data-expose="core.debug.timeline.select"]')];
    assert.equal(picks.findIndex((el) => el.closest("[data-selected]").dataset.selected === "true"), 699);
    await ui.filterDebugTimeline({ level: "info" });
    assert.equal(ui.debugState().timeline.selected, 1);
    const again = [...document.querySelectorAll('[data-expose="core.debug.timeline.select"]')];
    assert.equal(again.findIndex((el) => el.closest("[data-selected]").dataset.selected === "true"), 499);
  } finally {
    await close();
  }
  wire.finish();
});

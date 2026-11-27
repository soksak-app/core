import assert from "node:assert/strict";
import test from "node:test";
import { open } from "./support/debug-timeline.mjs";

test("rows are selected and unselected by index, and the status reports the count and the warning", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-select");
  try {
    await ui.showDebugTimeline();
    ui.selectDebugRow(2, true);
    ui.selectDebugRow(2, true);
    ui.selectDebugRow(0, true);
    assert.equal(ui.debugState().timeline.selected, 2);
    const picks = [...document.querySelectorAll('[data-expose="core.debug.timeline.select"]')];
    assert.deepEqual(picks.map((el) => el.closest("[data-selected]")?.dataset.selected ?? "none"), ["true", "false", "true"]);
    ui.selectDebugRow(2, false);
    assert.equal(ui.debugState().timeline.selected, 1);
    assert.throws(() => ui.selectDebugRow(3, true), /timeline row 3 is not one of the 3 rows/);
    assert.throws(() => ui.selectDebugRow(0, "yes"), /timeline selected must be a boolean, found "yes"/);
    assert.throws(() => ui.selectDebugRow(-1, true), /timeline row -1 is not one of the 3 rows/);
    assert.equal(document.querySelector('[data-expose="core.debug.timeline.warning"]').textContent, ui.debugState().timeline.warning);
  } finally {
    await close();
  }
  wire.finish();
});

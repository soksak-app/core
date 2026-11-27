import assert from "node:assert/strict";
import test from "node:test";
import { open, shownWhere } from "./support/debug-timeline.mjs";

test("a cancelled save panel leaves no error and an empty selection is refused with an error", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-save-cancelled");
  try {
    await ui.showDebugTimeline();
    await assert.rejects(ui.saveDebugRows(), /no timeline row is selected/);
    assert.match(ui.debugState().error, /^save-rows: no timeline row is selected/);
    assert.equal(shownWhere(), "debug");
    ui.selectDebugRow(0, true);
    assert.deepEqual(await ui.saveDebugRows(), { saved: null });
    assert.equal(ui.debugState().error, null);
    ui.listDebugFiles();
    await assert.rejects(ui.saveDebugRows(), /the debug timeline is not shown/);
  } finally {
    await close();
  }
  wire.finish();
});

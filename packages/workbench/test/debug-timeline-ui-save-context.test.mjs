import assert from "node:assert/strict";
import test from "node:test";
import { savesOf, open, rowsText } from "./support/debug-timeline.mjs";

test("the saved lines of selected rows are the lines of the events, also for a row that is only context", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-save-context");
  try {
    await ui.showDebugTimeline();
    await ui.filterDebugTimeline({ level: "warn" });
    await ui.contextDebugRow(2);
    const contextIndex = rowsText().findIndex((text) => text.startsWith("  "));
    ui.selectDebugRow(contextIndex, true);
    await ui.saveDebugRows();
    const saved = savesOf(wire);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].text.startsWith(" "), false, "the saved line has no indent");
    assert.equal(saved[0].text.split("\n").filter(Boolean).length, 1);
  } finally {
    await close();
  }
  wire.finish();
});

import assert from "node:assert/strict";
import test from "node:test";
import { open, changed, rowsText } from "./support/debug-timeline.mjs";

test("a row that a context query brought in and that following reads again stops being context", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-context-followed");
  try {
    await ui.showDebugTimeline();
    await ui.contextDebugRow(2);
    assert.equal(ui.debugState().timeline.context, 1, "the row that came after the tail is context");
    await changed(wire);
    assert.equal(ui.debugState().timeline.context, 0);
    assert.equal(rowsText().length, 4);
    assert.equal(rowsText().filter((text) => text.startsWith("  ")).length, 0);
  } finally {
    await close();
  }
  wire.finish();
});

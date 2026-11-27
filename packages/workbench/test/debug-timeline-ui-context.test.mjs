import assert from "node:assert/strict";
import test from "node:test";
import * as timelineModule from "../debug-timeline.js";
import { queriesOf, open, rowsText } from "./support/debug-timeline.mjs";

test("the context of a row brings its neighbours in key order whatever the filter is, marks them, and a new filter removes them", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-context");
  try {
    await ui.showDebugTimeline();
    await ui.filterDebugTimeline({ level: "warn" });
    assert.deepEqual(rowsText().map((text) => text.split(" ")[0].slice(0, 25)).length, 5, "the five rows of level warn");
    const calls = queriesOf(wire).length;
    // The third shown row is the event of seq 5; its two neighbours on each side are asked for.
    await ui.contextDebugRow(2);
    assert.deepEqual(queriesOf(wire).slice(calls), [{ channel: "other", around: { ts_us: 50, role: "host", boot: "a", seq: 5 }, earlier: timelineModule.CONTEXT_ROWS, later: timelineModule.CONTEXT_ROWS }]);
    const texts = rowsText();
    assert.equal(texts.length, 10, "the five rows of level warn and the five neighbours that the filter left out, which are all the others");
    assert.deepEqual(texts.filter((text) => text.startsWith("  ")).length, 5);
    assert.equal(ui.debugState().timeline.context, 5);
    assert.equal(ui.debugState().timeline.held, 10);
    // The row at the cursor and the rows that pass the filter are not context.
    assert.equal(texts.filter((text) => !text.startsWith("  ")).length, 5);
    const button = document.querySelector('[data-key="context:2"]');
    assert.equal(button.dataset.command, "core.debug.timeline.context");
    await ui.filterDebugTimeline({ level: "warn" });
    assert.equal(ui.debugState().timeline.context, 0, "a new filter shows its own rows only");
    assert.equal(rowsText().length, 5);
    await assert.rejects(ui.contextDebugRow(99), /timeline row 99 is not one of the 5 rows/);
    ui.listDebugFiles();
    await assert.rejects(ui.contextDebugRow(0), /the debug timeline is not shown/);
  } finally {
    await close();
  }
  wire.finish();
});

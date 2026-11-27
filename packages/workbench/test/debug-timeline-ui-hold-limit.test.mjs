import assert from "node:assert/strict";
import test from "node:test";
import { HOLD_LIMIT, PAGE_ROWS } from "../debug-timeline.js";
import { queriesOf, open, shownWhere, rowsText } from "./support/debug-timeline.mjs";

test("the view holds at most 2000 rows and refuses an older page beyond them with an error", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-hold-limit");
  try {
    await ui.showDebugTimeline();
    for (let page = 0; page < 3; page += 1) await ui.olderDebugTimeline();
    assert.equal(rowsText().length, HOLD_LIMIT);
    assert.equal(queriesOf(wire).at(-1).limit, HOLD_LIMIT - 3 * PAGE_ROWS, "the last page asks only for the room that is left");
    assert.equal(ui.debugState().timeline.older, true);
    await assert.rejects(ui.olderDebugTimeline(), /the timeline holds 2000 rows; narrow the filter or the time/);
    assert.match(ui.debugState().error, /^older: the timeline holds 2000 rows/);
    assert.equal(shownWhere(), "debug");
    assert.equal(rowsText().length, HOLD_LIMIT);
  } finally {
    await close();
  }
  wire.finish();
});

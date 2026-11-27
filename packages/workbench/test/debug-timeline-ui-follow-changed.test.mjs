import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_ROWS } from "../debug-timeline.js";
import { queriesOf, open, changed, names } from "./support/debug-timeline.mjs";

test("a changed event file adds the rows after the tail in time order, also a row with an earlier clock, and keeps the filter and the selection", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-follow-changed");
  try {
    await ui.showDebugTimeline();
    ui.selectDebugRow(2, true);
    await ui.filterDebugTimeline({ layer: "host" });
    const before = queriesOf(wire).length;
    // The host wrote two rows: the row of seq 5 has a clock earlier than the newest held row, and it is the row that only `since` finds.
    await changed(wire);
    assert.equal(queriesOf(wire).length, before + 1);
    assert.deepEqual(queriesOf(wire).at(-1), { channel: "other", level: "trace", layer: "host", order: "asc", limit: PAGE_ROWS, since: { "host-a": 3 } });
    const status = ui.debugState().timeline;
    assert.equal(status.held, 4);
    assert.equal(status.appended, 2);
    // The appended rows are the rows after the tail of the page that showed the timeline, up to the tail of the last read.
    assert.deepEqual([status.start, status.tail], [{ "host-a": 3 }, { "host-a": 5 }]);
    assert.equal(status.layer, "host");
    assert.equal(status.selected, 1);
    assert.deepEqual(names(), ["log.open", "host.window.created", "host.late.row", "host.app.event"]);
    await ui.filterDebugTimeline({ layer: "all" });
    assert.equal(ui.debugState().timeline.selected, 1);
    assert.equal(ui.debugState().error, null);
  } finally {
    await close();
  }
  wire.finish();
});

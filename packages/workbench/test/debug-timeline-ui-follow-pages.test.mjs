import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_ROWS } from "../debug-timeline.js";
import { queriesOf, open, changed } from "./support/debug-timeline.mjs";

test("following pages through the rows that grew until none is left and asks again from the first tail", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-follow-pages");
  try {
    await ui.showDebugTimeline();
    await changed(wire);
    const asked = queriesOf(wire).slice(-2);
    assert.deepEqual(asked.map((request) => request.order), ["asc", "asc"]);
    assert.equal(asked[0].after, undefined);
    assert.equal(asked[1].after.seq, 10 + PAGE_ROWS - 1);
    assert.deepEqual(asked[1].since, { "host-a": 3 }, "every page of one read asks after the same tail");
    assert.equal(ui.debugState().timeline.held, 3 + PAGE_ROWS + 20);
    assert.equal(ui.debugState().timeline.appended, PAGE_ROWS + 20);
    const calls = queriesOf(wire).length;
    await changed(wire);
    assert.deepEqual(queriesOf(wire)[calls].since, { "host-a": 10 + PAGE_ROWS + 19 });
    assert.equal(ui.debugState().timeline.held, 3 + PAGE_ROWS + 20, "a read that found nothing changed the rows");
  } finally {
    await close();
  }
  wire.finish();
});

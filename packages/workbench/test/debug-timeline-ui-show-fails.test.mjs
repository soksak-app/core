import assert from "node:assert/strict";
import test from "node:test";
import { open, shownWhere } from "./support/debug-timeline.mjs";

test("a query that fails when the timeline is shown leaves no timeline and shows the error with its file", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-show-fails");
  try {
    await assert.rejects(ui.showDebugTimeline(), /logs\/host-a\.jsonl:2: not JSON: broken/);
    assert.match(ui.debugState().error, /^timeline: logs\/host-a\.jsonl:2:/);
    assert.equal(shownWhere(), "debug");
    assert.equal(ui.debugState().timeline, null);
  } finally {
    await close();
  }
  wire.finish();
});

import assert from "node:assert/strict";
import test from "node:test";
import { open, shownWhere, changed } from "./support/debug-timeline.mjs";

test("a query that fails while following stops following and is shown with its file and line", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-follow-fails");
  try {
    await ui.showDebugTimeline();
    await changed(wire);
    assert.match(ui.debugState().error, /^follow: logs\/host-a\.jsonl:4: not JSON: broken/);
    assert.equal(shownWhere(), "debug");
    assert.equal(ui.debugState().timeline.following, false);
    assert.equal(ui.debugState().timeline.held, 3);
  } finally {
    await close();
  }
  wire.finish();
});

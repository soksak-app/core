import assert from "node:assert/strict";
import test from "node:test";
import { open, shownWhere, settled } from "./support/debug-timeline.mjs";

test("a refused call that tells the host whether the view follows is shown through the error display", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-follow-refused");
  try {
    await ui.showDebugTimeline();
    await settled();
    assert.equal(ui.debugState().error, "follow: argument request.following is missing");
    assert.equal(shownWhere(), "debug");
  } finally {
    await close();
  }
  wire.finish();
});

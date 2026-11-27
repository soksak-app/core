import assert from "node:assert/strict";
import test from "node:test";
import { queriesOf, open, changed } from "./support/debug-timeline.mjs";

test("a notice of a file that is not an event file reads nothing, and a notice without a timeline too", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-follow-other-files");
  try {
    await changed(wire);
    assert.equal(queriesOf(wire).length, 0, "a notice while no timeline is shown asked");
    await ui.showDebugTimeline();
    const calls = queriesOf(wire).length;
    await changed(wire);
    await changed(wire);
    assert.equal(queriesOf(wire).length, calls);
  } finally {
    await close();
  }
  wire.finish();
});

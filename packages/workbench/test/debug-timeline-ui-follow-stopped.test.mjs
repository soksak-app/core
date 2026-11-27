import assert from "node:assert/strict";
import test from "node:test";
import { queriesOf, followsOf, open, changed } from "./support/debug-timeline.mjs";

// contract: debug.follow.view-tells-whether-it-follows
test("stopping follows no more queries and resuming asks for what grew while stopped", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-follow-stopped");
  try {
    await ui.showDebugTimeline();
    await ui.followDebugTimeline(false);
    assert.equal(ui.debugState().timeline.following, false);
    const button = document.querySelector('[data-expose="core.debug.timeline.follow"]');
    assert.equal(button.dataset.command, "core.debug.timeline.follow");
    assert.deepEqual(JSON.parse(button.dataset.params), { on: true });
    const calls = queriesOf(wire).length;
    await changed(wire);
    assert.equal(queriesOf(wire).length, calls);
    assert.equal(ui.debugState().timeline.held, 3);
    await ui.followDebugTimeline(true);
    assert.equal(ui.debugState().timeline.following, true);
    assert.equal(ui.debugState().timeline.held, 4);
    assert.equal(ui.debugState().timeline.appended, 1);
    assert.deepEqual(JSON.parse(button.dataset.params), { on: false });
    await assert.rejects(ui.followDebugTimeline("yes"), /timeline follow must be a boolean, found "yes"/);
    ui.listDebugFiles();
    await assert.rejects(ui.followDebugTimeline(true), /the debug timeline is not shown/);
  } finally {
    await close();
  }
  wire.finish();
  // Only a window that follows receives the notices (docs/spec/debug.md#files): the view tells the host each change of its following.
  assert.deepEqual(followsOf(wire), [true, false, true, false], "the view did not tell the host each start and stop of following");
});

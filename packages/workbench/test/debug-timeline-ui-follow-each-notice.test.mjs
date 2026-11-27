import assert from "node:assert/strict";
import test from "node:test";
import * as timelineModule from "../debug-timeline.js";
import { open, changed } from "./support/debug-timeline.mjs";

test("the timeline asks at each notice without a pause of its own and loses no row", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-follow-each-notice");
  try {
    await ui.showDebugTimeline();
    // The rate of the notices is bounded by the host (docs/spec/debug.md#following), so the view has no timer: the second notice is
    // answered at once and asks for what grew meanwhile. The timeline module has no timer of its own, and the host bounds the notices
    // by contract (docs/spec/debug.md#following), so each notice is answered by its own query.
    assert.equal("FOLLOW_INTERVAL_MS" in timelineModule, false, "the view keeps an interval of its own");
    await changed(wire);
    await changed(wire);
    assert.equal(ui.debugState().timeline.held, 5, "a row that grew was not added");
  } finally {
    await close();
  }
  wire.finish();
});

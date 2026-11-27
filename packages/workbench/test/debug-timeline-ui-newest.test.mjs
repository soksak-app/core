import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_ROWS } from "../debug-timeline.js";
import { queriesOf, followsOf, open, WARNING, names } from "./support/debug-timeline.mjs";

test("the timeline asks for the newest page and shows it oldest first with the status of the pages", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-newest");
  try {
    await ui.showDebugTimeline();
    assert.deepEqual(queriesOf(wire), [{ channel: "other", level: "trace", order: "desc", limit: PAGE_ROWS }]);
    assert.deepEqual(names(), ["log.open", "host.window.created", "workbench.call.slow"]);
    assert.deepEqual(ui.debugState().timeline, {
      following: true, appended: 0, held: 3, older: false, omitted: 0, context: 0, selected: 0, warning: WARNING,
      start: { "host-a": 3 }, tail: { "host-a": 3 }, channel: "other", level: "trace", class: "", layer: "all", text: "", event: "", event_prefix: "", surface: "", session: "", cid: "", run: "", from: "", to: "",
    });
    assert.equal(document.querySelector('[data-key="timeline-older"]').hidden, true);
    assert.equal(document.querySelector('[data-expose="core.debug.timeline.omitted"]').hidden, true);
    ui.listDebugFiles();
    assert.equal(ui.debugState().timeline, null);
  } finally {
    await close();
  }
  wire.finish();
  assert.deepEqual(followsOf(wire), [true, false], "the shown and the left timeline did not tell the host whether the view follows");
});

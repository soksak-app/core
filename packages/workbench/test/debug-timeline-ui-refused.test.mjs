import assert from "node:assert/strict";
import test from "node:test";
import { open, shownWhere, names } from "./support/debug-timeline.mjs";

test("a query that the host refuses is shown through the error display and the shown rows stay", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-refused");
  try {
    await ui.showDebugTimeline();
    await assert.rejects(ui.filterDebugTimeline({ level: "loud" }), /log query level "loud" is not one of/);
    assert.match(ui.debugState().error, /^filter: log query level "loud" is not one of error, warn, info, debug, trace/);
    assert.equal(shownWhere(), "debug");
    assert.equal(ui.debugState().timeline.level, "trace");
    assert.deepEqual(names(), ["log.open", "host.window.created", "workbench.call.slow"]);
  } finally {
    await close();
  }
  wire.finish();
});

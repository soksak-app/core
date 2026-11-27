// The errors of the state view (docs/spec/debug.md): a state file that is not a state, a comparison without a shown state, and a file that is
// not a state file are errors that the view shows through the notice path and writes to the application log.
// The host calls of the test are the page-wire case of the test (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import test from "node:test";
import { openState, shownText } from "./support/debug-state.mjs";

test("a state file that is not a state or a comparison without a shown state is an error that is shown", async () => {
  const { ui, wire, calls, flushEvents, close } = await openState("debug-state-ui-errors");
  try {
    await assert.rejects(ui.compareDebugState("logs/state-2.json"), /the debug state is not shown/);
    await assert.rejects(ui.showDebugState("logs/state-3.json"), /logs\/state-3\.json: not a state object: \[1\]/);
    assert.notEqual(shownText(), null, "the failure is shown as an error notice");
    assert.match(shownText(), /^state: logs\/state-3\.json: not a state object/);
    // The error record leaves in a batch of the page log, after the ordered calls of the view.
    await calls();
    await flushEvents();
    await assert.rejects(ui.showDebugState("logs/host-a.stderr"), /logs\/host-a\.stderr is not a state file/);
    await ui.showDebugState("logs/state-1.json");
    await assert.rejects(ui.compareDebugState("logs/state-9.json"), /logs\/state-9\.json is not a state file/);
  } finally {
    await close();
  }
  wire.finish();
});

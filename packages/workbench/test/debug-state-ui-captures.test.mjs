// The captures of the debug status (docs/spec/debug.md): the host owns the exact still PNG paths of a recording, and the fixture input
// changes only the listing. The host calls of the test are the page-wire case of the test (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import test from "node:test";
import { openState, recordCalls } from "./support/debug-state.mjs";

test("debug status exposes exact host-owned captures while fixture input changes only the listing", async () => {
  const captures = ["/config/logs/captures/still-main-1/window.png", "/config/logs/captures/still-project-2/window.png"];
  const { ui, wire, close } = await openState("debug-state-ui-captures");
  try {
    assert.deepEqual(ui.debugState().captures, captures);
    ui.setDebugFixtureEntries([{ path: "logs/fixture.log", size: 1, modified: 1 }]);
    await ui.openDebug();
    assert.equal(recordCalls(wire).length, 2, "the listing fixture must not suppress the real recording call");
    assert.deepEqual(ui.debugState().captures, captures);
    assert.deepEqual(ui.debugState().entries.map(entry => entry.path), ["logs/fixture.log"]);
  } finally {
    await close();
  }
  wire.finish();
});

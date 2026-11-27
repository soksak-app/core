// The captures of a new recording (docs/spec/debug.md): a new record clears the capture ownership of the previous one when the host returns
// none or fails. The host calls of the test are the page-wire case of the test (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import test from "node:test";
import { openState } from "./support/debug-state.mjs";

test("a new debug record clears previous capture ownership when the host returns none or fails", async () => {
  const { ui, wire, close } = await openState("debug-state-ui-captures-cleared");
  try {
    assert.deepEqual(ui.debugState().captures, ["/config/logs/captures/still-main-1/window.png"]);
    ui.closeDebug();
    await ui.openDebug();
    assert.deepEqual(ui.debugState().captures, []);
    ui.closeDebug();
    await ui.openDebug();
    assert.deepEqual(ui.debugState().captures, []);
    assert.match(ui.debugState().error, /record: recording failed/);
  } finally {
    await close();
  }
  wire.finish();
});

// A save while one writes is refused with an error, and a failure that the done event reports is shown (docs/spec/debug.md#save). The host
// calls and the host events of the test are the page-wire case of the test (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import test from "node:test";
import { openSaveView } from "./support/debug-save.mjs";

test("a save while one writes is refused and shown, and a failure of the write is shown", { timeout: 5000 }, async () => {
  const { ui, wire, calls, flushEvents, close } = await openSaveView("debug-save-ui-refused");
  try {
    await ui.saveDebugFiles();
    await assert.rejects(ui.saveDebugFiles(), /debug: a save of the logs folder is running: \/d\/soksak\.tar\.gz/);
    assert.match(ui.debugState().error, /a save of the logs folder is running/);
    // The shown error is written to the application log in a batch, which leaves after the ordered calls of the view.
    await calls();
    wire.deliverNotice();
    await calls();
    await flushEvents();
    assert.equal(ui.debugState().operation.state, "failed");
    assert.match(ui.debugState().error, /disk full/);
    await calls();
    await flushEvents();
  } finally {
    await close();
  }
  wire.finish();
});

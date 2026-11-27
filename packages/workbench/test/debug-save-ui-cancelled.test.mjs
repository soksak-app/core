// A cancelled save panel ends the operation without a progress bar (docs/spec/debug.md#save). The host calls of the test are the page-wire
// case of the test (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import test from "node:test";
import { openSaveView, progressBar, saveButton } from "./support/debug-save.mjs";

test("a cancelled save panel ends the operation without a progress bar", { timeout: 5000 }, async () => {
  const { ui, wire, close } = await openSaveView("debug-save-ui-cancelled");
  try {
    assert.deepEqual(await ui.saveDebugFiles(), { saved: null, total: 0 });
    assert.deepEqual(ui.debugState().operation, { action: "save-all", path: null, state: "done" });
    assert.equal(progressBar().closest(".dbg-card__progress").hidden, true);
    assert.equal(saveButton().disabled, false);
  } finally {
    await close();
  }
  wire.finish();
});

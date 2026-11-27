// The save of the logs folder shows the progress that the host reports, shows the button disabled while it writes, and ends with the done
// event (docs/spec/debug.md#save). The host calls and the host events of the test are the page-wire case of the test
// (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import test from "node:test";
import { openSaveView, progressBar, saveButton } from "./support/debug-save.mjs";

test("a save shows the progress that the host reports, shows the button disabled, and ends with the done event", { timeout: 5000 }, async () => {
  const { ui, wire, calls, close } = await openSaveView("debug-save-ui-progress");
  try {
    assert.deepEqual(await ui.saveDebugFiles(), { saved: "/d/soksak.tar.gz", total: 3000 });
    assert.deepEqual(ui.debugState().operation, { action: "save-all", path: "/d/soksak.tar.gz", state: "running", written: 0, total: 3000 });
    assert.equal(progressBar().closest(".dbg-card__progress").hidden, false, "the progress bar is hidden while the save runs");
    assert.equal(saveButton().disabled, true, "the button of the save is not disabled while the save runs");
    await calls();
    wire.deliverNotice();
    assert.equal(ui.debugState().operation.written, 1500);
    assert.equal(progressBar().value, 1500);
    assert.equal(progressBar().max, 3000);
    await calls();
    wire.deliverNotice();
    assert.deepEqual(ui.debugState().operation, { action: "save-all", path: "/d/soksak.tar.gz", state: "done", written: 3000, total: 3000 });
    assert.equal(progressBar().closest(".dbg-card__progress").hidden, true);
    assert.equal(saveButton().disabled, false);
  } finally {
    await close();
  }
  wire.finish();
});

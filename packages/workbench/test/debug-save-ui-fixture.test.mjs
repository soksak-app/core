// A diagnostic debug fixture uses the existing list renderer and resets to live entries (docs/spec/debug.md). The host calls of the test are
// the page-wire case of the test (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import test from "node:test";
import { openSaveView } from "./support/debug-save.mjs";

test("a diagnostic debug fixture uses the existing list renderer and resets to live entries", { timeout: 5000 }, async () => {
  const entries = [
    { path: "logs/design/a.log", size: 12, modified: 2000 },
    { path: "logs/design/b.log", size: 3, modified: 1000 },
  ];
  const { ui, wire, calls, close } = await openSaveView("debug-save-ui-fixture", entries);
  try {
    assert.deepEqual(ui.debugState().entries, entries);
    assert.equal(document.querySelectorAll('[data-expose="core.debug.file"]').length, 2,
      "the ordinary file list must render every declared entry");
    assert.equal(document.querySelectorAll('[data-expose="core.debug.save"]').length, 2,
      "fixture rows keep the existing action controls rather than a new layout");
    ui.closeDebug();
    ui.setDebugFixtureEntries(null);
    await ui.openDebug();
    await calls();
    assert.deepEqual(ui.debugState().entries, []);
    assert.equal(document.querySelectorAll('[data-expose="core.debug.file"]').length, 0);
  } finally {
    await close();
  }
  wire.finish();
});

// The file list of the debug view (docs/spec/debug.md): raw stderr and crash files get a view button, and only state files get a state
// button. The host calls of the test are the page-wire case of the test (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import test from "node:test";
import { openState } from "./support/debug-state.mjs";

test("the file list holds the raw stderr and crash files with a view button, and a state button only on state files", async () => {
  const { ui, wire, close } = await openState("debug-state-ui-file-list");
  try {
    const paths = ui.debugState().entries.map((entry) => entry.path);
    assert.ok(paths.includes("logs/host-a.stderr") && paths.includes("logs/host-a.crash"));
    const views = [...document.querySelectorAll('[data-expose="core.debug.view"]')].map((el) => JSON.parse(el.dataset.params).path);
    assert.ok(views.includes("logs/host-a.stderr") && views.includes("logs/host-a.crash"));
    const states = [...document.querySelectorAll('[data-expose="core.debug.state"]')].map((el) => JSON.parse(el.dataset.params).path);
    assert.deepEqual(states.toSorted(), ["logs/state-1.json", "logs/state-2.json"]);
    await ui.viewDebugFile("logs/host-a.crash");
    assert.equal(document.querySelector('[data-expose="core.debug.text"]').textContent, "fatal error\n");
  } finally {
    await close();
  }
  wire.finish();
});

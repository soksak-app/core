// The state view of the debug view (docs/spec/debug.md): a state file is shown as a tree, and two state files are compared line by line.
// The host calls of the test are the page-wire case of the test (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import test from "node:test";
import { diffText, linesText, openState } from "./support/debug-state.mjs";

test("a state file is shown as a tree and two state files are compared", async () => {
  const { ui, wire, close } = await openState("debug-state-ui-compare");
  try {
    await ui.showDebugState("logs/state-1.json");
    assert.ok(linesText().some((line) => line.endsWith('core: "0.0.10"')));
    assert.deepEqual(ui.debugState().state, { path: "logs/state-1.json", lines: 7, with: null, differences: 0 });
    assert.equal(ui.debugState().viewing, null);
    await ui.compareDebugState("logs/state-2.json");
    assert.deepEqual(diffText(), ['versions.core: "0.0.10" -> "0.0.11"', 'workbench.modal: null -> "debug"']);
    assert.deepEqual(ui.debugState().state, { path: "logs/state-1.json", lines: 7, with: "logs/state-2.json", differences: 2 });
    const select = document.querySelector('[data-expose="core.debug.state.with"]');
    assert.equal(select.dataset.command, "core.debug.state.compare");
    assert.equal(select.dataset.value, "with");
    assert.deepEqual([...select.options].map((option) => option.value), ["", "logs/state-2.json"]);
    await ui.compareDebugState("");
    assert.equal(ui.debugState().state.with, null);
    assert.deepEqual(diffText(), []);
    ui.listDebugFiles();
    assert.equal(ui.debugState().state, null);
  } finally {
    await close();
  }
  wire.finish();
});

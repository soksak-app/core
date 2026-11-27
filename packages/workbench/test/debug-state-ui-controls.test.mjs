// The bound controls of the state view (docs/spec/exposure.md): every interactive element points to a declared command and has an element
// name. The host calls of the test are the page-wire case of the test (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import test from "node:test";
import { openState } from "./support/debug-state.mjs";

test("every interactive element of the state view points to a declared command and has an element name", async () => {
  const { ui, wire, close } = await openState("debug-state-ui-controls");
  try {
    await ui.showDebugState("logs/state-1.json");
    const controls = [...document.querySelectorAll(".dbg-card button, .dbg-card input, .dbg-card select")];
    assert.ok(controls.some((el) => el.dataset.command === "core.debug.state.compare"));
    for (const el of controls) {
      assert.ok(el.dataset.command, `${el.outerHTML} has no command`);
      assert.ok(el.dataset.expose, `${el.outerHTML} has no element name`);
    }
  } finally {
    await close();
  }
  wire.finish();
});

// A document region takes typed text on the virtual key window: the window takes the press and the keys without activation, and
// each character key states its text, which the web view of the region inserts through its text input, so the application and
// the input source of the person stay as they are (docs/spec/exposure.md#virtual-key-window). The document region of the input
// probe holds a text field that fills it and reports the keys and the text that reach it.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { documentFocused, documentPoint, inputProbeTab } from "./input-probe.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: the virtual key window gives a document region typed text`, async (t) => {
    const s = await open(t, app, { inactive: true });
    await fresh(s);
    const { surface } = await inputProbeTab(s);
    await s.presented();
    const point = await documentPoint(s, surface);
    // A pointer move that presses nothing makes the window the virtual key window.
    await s.pointer(point.x, point.y, "move");
    await s.until("host.window", (state) => state.virtualKey, "the window did not become the virtual key window");
    await s.click(point.x, point.y);
    await s.until("host.window", (value) => documentFocused(value, surface),
      "a press on the field did not give the region the keyboard focus");
    await s.until("probeinput.document", (value) => value.focused, "the field of the region did not take the focus", { surface });
    await s.press("x", { text: "x" });
    await s.press("y", { text: "y" });
    try {
      await s.until("probeinput.document", (value) => value.value === "xy", "typed keys did not reach the field", { surface });
    } catch (error) {
      const { key, virtualKey, active, responder, documents, input } = await s.get("host.window");
      const { value, keys } = await s.get("probeinput.document", surface);
      error.message += `; field ${JSON.stringify({ value, keys })}; host.window ${JSON.stringify({ key, virtualKey, active, responder, documents, input })}`;
      throw error;
    }
    const { keys } = await s.get("probeinput.document", surface);
    assert.deepEqual(keys.filter((key) => key.type === "keydown").map((key) => key.key), ["x", "y"]);
  });
}

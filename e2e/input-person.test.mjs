// A press, a move or a scroll of a person ends the open synthetic gesture of a pointer, and the next drag of that gesture answers
// 1013 with the message that names the action of the person (docs/spec/exposure.md#named-pointers). The check makes the action of
// a person in its own application with diagnostics.input.person, which dispatches the event that the window server gives the
// application for that action through -[NSApplication sendEvent:] (docs/spec/endpoint.md); it sends nothing to the system and moves
// no cursor of the person.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";

/** The actions of a person and the words of the message that names each. */
const ACTIONS = [["press", "down of the left button"], ["move", "move"], ["scroll", "scroll"]];

for (const app of Object.values(APPS)) {
  test(`${app.name}: an action of a person ends the synthetic gesture and the next drag answers 1013`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    // Each drag after an action of a person is refused on purpose, and a refused input is an error record of the native library.
    s.expectError(/^error native input inject: \{"kind":"pointer","pointer":"main",.*"phase":2,.*"result":"interrupted"/);
    // A press of a person reaches only the key window of the application without an activation, so the check makes the window
    // the virtual key window first (docs/spec/exposure.md#virtual-key-window).
    const content = (await s.get("host.window")).content;
    const x = Math.round(content.width / 2);
    const y = Math.round(content.height / 2);
    await s.pointer(x, y, "move", { activate: true });
    await s.until("host.window", (state) => state.virtualKey, "the window did not become the virtual key window");
    for (const [action, words] of ACTIONS) {
      await s.until("host.buttons", (value) => value.mask === 0, "a mouse button stayed pressed");
      await s.pointer(x, y, "down");
      await s.pointer(x + 2, y, "drag");
      assert.equal(await s.request("diagnostics.input.person", { action, x: x + 20, y: y + 10 }), null);
      await assert.rejects(s.pointer(x + 4, y, "drag"), (error) => {
        assert.equal(error.code, 1013, `${action}: ${error.message}`);
        assert.ok(error.message.endsWith(`a person's ${words} at (${x + 20}, ${y + 10}) in the window of the gesture ended the `
          + `synthetic gesture of pointer main, whose press was released at (${x + 2}, ${y})`), `${action}: ${error.message}`);
        return true;
      });
      // The interruption answers once and ended the press, so a new gesture of the pointer is delivered.
      await s.until("host.buttons", (value) => value.mask === 0, "a mouse button stayed pressed");
      await s.pointer(x, y, "down");
      await s.pointer(x, y, "up");
    }
  });
}

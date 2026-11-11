// The activation of input.pointer is emulated by the host (docs/spec/exposure.md#methods), so a session sends the move with
// activate and asks the system for nothing.
import assert from "node:assert/strict";
import test from "node:test";

import { Session } from "../app.mjs";

test("a session sends an activating move to the host only", async () => {
  const sent = [];
  const session = {
    window: "main",
    presses: new Map(),
    client: { endpoint: { pid: 0 } },
    request: async (method, params) => { sent.push([method, params]); return null; },
  };
  await Session.prototype.pointer.call(session, 10, 20, "move", { activate: true });
  assert.deepEqual(sent, [["input.pointer", { x: 10, y: 20, phase: "move", activate: true }]]);
});

// The activation of input.pointer is emulated by the host (docs/spec/exposure.md#methods), so a session sends the move with
// activate and asks the system for nothing.
import test from "node:test";

import { Session } from "../app.mjs";
import { playSession } from "../fixtures/endpoint-player.mjs";

test("a session sends an activating move to the host only", { timeout: 5000 }, async (t) => {
  // The case holds the one request of the move: the player fails a request that is not in it.
  const { session } = await playSession(t, Session, "window-check-pointer-activate", "mygo");
  await session.pointer(10, 20, "move", { activate: true });
});

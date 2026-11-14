// The text step of a session sends input.text with the step, its text and its ranges, and unmark without a text
// (docs/spec/exposure.md#methods).
import test from "node:test";

import { Session } from "../app.mjs";
import { playSession } from "../fixtures/endpoint-player.mjs";

test("a session sends a step of a composition as input.text", { timeout: 5000 }, async (t) => {
  // The case holds the three requests with their parameters: the player fails a request that differs from it.
  const { session } = await playSession(t, Session, "window-check-input-text", "mygo");
  await session.text("mark", "한", { selection: { start: 0, length: 1 } });
  await session.text("insert", "한글", { replacement: { start: 2, length: 1 } });
  await session.text("unmark");
});

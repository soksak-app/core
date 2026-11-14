import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../app.mjs";
import { playSession } from "../fixtures/endpoint-player.mjs";

// The session reports an error of the endpoint as `<application> <method>: <text of the host>`, so a check that judges a
// refusal of the host compares that form (e2e/capture-state.test.mjs): a second start while a recording runs and a stop
// without a recording.
test("the session reports a refused second start and a refused stop with the application and the method", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-capture-refused", "wailsv3");
  const gap = 1000 / 120;
  const started = await session.request("diagnostics.capture.start", { gap, frames: 4096 });
  await assert.rejects(
    session.request("diagnostics.capture.start", { gap, frames: 1 }),
    (error) => error.message === `wailsv3 diagnostics.capture.start: a capture into ${started.frames} is running`,
    "the refused second start has another error than the error form of the session",
  );
  await session.request("diagnostics.capture.stop", {});
  await assert.rejects(
    session.request("diagnostics.capture.stop", {}),
    (error) => error.message === "wailsv3 diagnostics.capture.stop: no capture is running",
    "the refused stop has another error than the error form of the session",
  );
});

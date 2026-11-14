import assert from "node:assert/strict";
import test from "node:test";
import * as harness from "../app.mjs";
import { playSession } from "../fixtures/endpoint-player.mjs";

// Window checks are end-to-end checks that run only on a computer with a display and a person (docs/operations/examples.md#test-kinds),
// so the harness has no path for a run without them.
test("the harness exports no options that skip a check in a run without a display or a person", { timeout: 1000 }, () => {
  const names = Object.keys(harness).filter((name) =>
    ["RECORDING", "PERSON", "displayPresents", "recordingOptions", "personAnswers", "personOptions"].includes(name));
  assert.deepEqual(names, []);
});

test("a recording request is sent whatever the environment of the run holds", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, harness.Session, "window-check-display-requests", "wailsv3");
  const previous = process.env.SOKSAK_CHECK_DISPLAY;
  t.after(() => { if (previous === undefined) delete process.env.SOKSAK_CHECK_DISPLAY; else process.env.SOKSAK_CHECK_DISPLAY = previous; });
  process.env.SOKSAK_CHECK_DISPLAY = "absent";
  // The case holds exactly these two requests, so another request or a request left out fails the player when it closes.
  await session.request("diagnostics.capture.start", {});
  await session.request("diagnostics.drag", { capture: true });
});

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Session } from "../app.mjs";
import { playSession } from "../fixtures/endpoint-player.mjs";

/**
 * A session whose host answers the requests of a recording on a display of 120 Hz with the case `name`, whose `frames` is the
 * folder of the recording that the host created.
 */
async function recording(t, name) {
  const frames = realpathSync(mkdtempSync(join(tmpdir(), "soksak-recording-covered-")));
  t.after(() => rmSync(frames, { recursive: true, force: true }));
  const { session } = await playSession(t, Session, name, "mygo", { values: { frames } });
  return { session, frames };
}

// A recording reads the window itself, whatever the windows of other applications in front of it, and holds the covered
// drawing until it stops, so the regions of a covered window draw as they do on the screen. It reads no occlusion state.
// Each case holds the requests in their order: the player fails a request that is not in the case.
test("a recording holds the covered drawing of its window from before the capture starts", { timeout: 5000 }, async (t) => {
  const { session, frames } = await recording(t, "window-check-recording-covered-start");
  const recorded = await session.record();
  assert.equal(recorded.frames, frames);
});

test("the stop of a recording ends its hold of the covered drawing, also when the stop fails", { timeout: 5000 }, async (t) => {
  const { session } = await recording(t, "window-check-recording-covered-stop-fails");
  const recorded = await session.record();
  assert.equal(await recorded.stop({ after: 0 }), null);
});

// A recording of a new window (newWindow) reads a window that the application creates after the start answers, so the covered
// drawing of the requesting window is not its concern: the start goes to the host without that hold, and the stop ends nothing.
test("a recording of a new window starts without a hold of the covered drawing of the requesting window", { timeout: 5000 }, async (t) => {
  const { session, frames } = await recording(t, "window-check-recording-covered-new-window");
  const recorded = await session.record({ newWindow: true });
  assert.equal(recorded.frames, frames);
  assert.equal(await recorded.stop({ after: 0 }), null);
});

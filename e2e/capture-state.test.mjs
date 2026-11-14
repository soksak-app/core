// The state of the recording of the host with the real recorder of the window server (docs/spec/endpoint.md,
// `diagnostics.capture.start` and `diagnostics.capture.stop`): one recording runs at a time, a stop keeps the folder and reports
// the written frames and the recorded window, a stop without a recording fails, and each recording prepares its target again,
// also for the same window and for another target. The decisions of the state on the answers of the recorder are judged by the
// unit tests of the hosts (docs/spec/cases/recording/decisions.json); this check judges the recorder that gives those answers.
// contract: recording.finish.reports-the-recorded-window, recording.finish.reply-reports-folder-frames-window, recording.target.prepared-each-recording, recording.target.different-target-reopened
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { frames } from "@soksak/window-check/frame.mjs";
import { requireNoLostStills } from "@soksak/window-check/stills.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: one recording runs at a time and a stop keeps its folder and names its frames and window`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // A refused request is an error that the requester receives; the hosts write an error line only for a request that ended without
    // its result (endpoint no result), so these refusals declare no expected application error.
    const { refreshRate } = await s.get("host.window");
    const gap = 1000 / refreshRate;
    // Window, display, then the same window again: each start prepares its target again.
    for (const params of [{}, { display: true }, {}]) {
      const recording = await s.record(params);
      assert.ok(existsSync(recording.frames), `the folder ${recording.frames} of the running recording is absent`);
      await assert.rejects(
        s.request("diagnostics.capture.start", { gap, frames: 1 }),
        (error) => error.message === `a capture into ${recording.frames} is running`,
        "a second start was accepted while a recording ran",
      );
      const stopped = await recording.stop();
      const rows = recording.judge();
      requireNoLostStills(rows, "the recording");
      assert.equal(stopped.frames, recording.frames, "the stop names another folder than the start");
      assert.ok(existsSync(recording.frames), `the stop removed the folder ${recording.frames}`);
      assert.equal(stopped.count, frames(recording.frames).length, "the stop count differs from the frame files of the folder");
      assert.ok(stopped.count > 0, "the recording wrote no frame");
      assert.equal(stopped.window === null, params.display === true,
        `the stop names the window ${JSON.stringify(stopped.window)} for a recording ${params.display ? "of the display" : "of a window"}`);
      await assert.rejects(
        s.request("diagnostics.capture.stop", {}),
        (error) => error.message === "no capture is running",
        "a second stop of one recording was accepted",
      );
    }
  });
}

import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { preserveDisplayLinkArtifact } from "./display-link-artifact.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: capture stop preserves its display-link metadata`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const window = await s.get("host.window");
    assert.equal(window.active, false, "the capture check must not activate its host");
    const settings = await s.get("core.settings");
    const originalTextSize = settings.values.textSize;
    assert.ok(Number.isFinite(originalTextSize), "the common textSize setting is unavailable");
    const nextTextSize = originalTextSize === 1 ? 1.1 : 1;
    const recording = await s.record();
    let stop;
    let stopAttempted = false;
    const failures = [];
    try {
      await s.run("core.settings.set", { patch: { textSize: nextTextSize }, scope: "common" });
      await s.until("core.text", (value) => value.frame === nextTextSize,
        `the frame text size did not become ${nextTextSize}`);
      const { displayed } = await s.presented();
      stopAttempted = true;
      stop = await recording.stop({ after: displayed });
    } catch (error) {
      failures.push(error);
    }
    if (!stopAttempted) {
      stopAttempted = true;
      try {
        stop = await recording.stop({ after: 0 });
      } catch (error) {
        failures.push(error);
      }
    }
    let saved;
    try {
      saved = preserveDisplayLinkArtifact({ frames: recording.frames, stop, configDir: app.configDir,
        requireStopReply: stop !== undefined });
    } catch (error) {
      failures.push(error);
    }
    if (saved) {
      const { record, evidencePath } = saved;
      if (record.state === "unavailable")
        t.diagnostic(`display-link unavailable: ${record.reason}; this run provides no independent refresh-cadence evidence`);
      else if (record.state === "incomplete")
        failures.push(new Error(`capture returned an incomplete display-link trace: ${record.reason}; artifact preserved at ${evidencePath}`));
      else
        t.diagnostic(`display-link available with ${record.observations.length} observations; preserved at ${evidencePath}; ` +
          "timestamps are refresh observations, not frame-presentation or cadence acceptance");
      try {
        assert.equal((await s.get("host.window")).active, false, "the host became active during the non-activating capture check");
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await s.run("core.settings.set", { patch: { textSize: originalTextSize }, scope: "common" });
      await s.until("core.text", (value) => value.frame === originalTextSize,
        `the frame text size did not return to ${originalTextSize}`);
      await s.presented();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "capture artifact check failed");
  });
}

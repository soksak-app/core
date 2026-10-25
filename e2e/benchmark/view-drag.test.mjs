import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { availableParallelism, loadavg } from "node:os";
import test from "node:test";
import { APPS, drag, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { fresh } from "../fixture.mjs";
import { outside, terminalMarks } from "../outside.mjs";
import { assertDragPerformance, assertHeldStatesShown, assertRoundTrips,
  measureDragPerformance, pointerLag, transactionCadence } from "../drag-measurement.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: terminal view drag meets performance targets with performance and renderer traces disabled`, { timeout: 60000 }, async t => {
    assert.equal(process.env.SOKSAK_PERFORMANCE_TRACE, undefined, "the benchmark requires performance tracing to be unset");
    assert.equal(process.env.SOKSAK_VT_TRACE_DIR, undefined, "the benchmark requires renderer tracing to be unset");
    const s = await open(t, app);
    const terminal = await fresh(s, { performanceTrace: false });
    const { values } = await s.get("core.settings");
    assert.equal(values["diagnostics.performance"], false, "the application performance trace is enabled");
    assert.deepEqual(values["diagnostics.log"], {}, "the application is not using its default error-only log policy");
    assert.equal((await s.get("terminal.cursor", terminal.surface)).render, null, "the renderer trace is enabled in the application");
    await keepCommonSettings(s);
    await s.run("core.settings.link", { place: "window-right", plugin: "terminal", set: "set-install", scope: "common" });
    await s.until("core.rail", rail => rail.groups.length === 1, "the terminal override drew no rail");
    const marks = await terminalMarks(s, { measured: true });
    const run = await drag(t, s, { axis: "x", line: 1, dx: 250, dy: 0, ms: 400, times: 2 }, { capture: true });
    const directory = mkdtempSync(join(app.configDir, "logs", "view-drag-benchmark-"));
    writeFileSync(join(directory, "layouts.json"), JSON.stringify({ layouts: run.layouts }, null, 2) + "\n");
    const files = frames(run.frames);
    assert.equal(files.length, run.count, "the benchmark recording omitted a frame file");
    assert.ok(files.length > 30, "the benchmark has too few captured frames");
    const samples = [];
    const times = [];
    const unmeasured = [];
    for (const [index, file] of files.entries()) {
      const frame = readFrame(file);
      times.push(frame.time);
      const at = outside(frame, marks);
      if (at) samples.push({ time: frame.time, position: at.card.l / at.scale });
      else unmeasured.push(index);
    }
    assert.ok(samples.length > files.length * 0.5, `only ${samples.length}/${files.length} frames have measured geometry`);
    assertRoundTrips(samples.map(sample => sample.position), 2);
    assertHeldStatesShown(samples, run.ticks, run.boundary);
    const lag = pointerLag(samples, run.ticks, run.boundary);
    const refreshRate = (await s.get("host.window")).refreshRate;
    const performance = measureDragPerformance(times, lag, refreshRate);
    const report = { host: app.name, performance, mode: { performanceTrace: false, rendererTrace: false,
      logPolicy: {}, recording: true }, load: loadavg(), processors: availableParallelism(),
      frameCount: files.length, unmeasured, samples, times, ticks: run.ticks, boundary: run.boundary,
      layouts: run.layouts, transactionCadence: transactionCadence(run.layouts) };
    const result = join(directory, "result.json");
    writeFileSync(result, JSON.stringify(report, null, 2) + "\n");
    t.diagnostic(`benchmark report ${result}: ${JSON.stringify(performance)}`);
    t.diagnostic(`transaction cadence (ms): ${JSON.stringify(report.transactionCadence)}`);
    assertDragPerformance(times, lag, refreshRate);
  });
}

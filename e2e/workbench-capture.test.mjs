// Functional root-chrome evidence under the benchmark default policy.
// Preserves the benchmark's fresh -> preparation -> native first drag -> captured
// second drag order on the floor page view of the view drag benchmark. It makes no performance acceptance claim.
// The same order judges the layouts of the second drag, a divider drag that moves the floor page view (docs/spec/native-surfaces.md):
// the commits of the view drag follow one another within two display refreshes, counted between the display refreshes that carried
// them (commitCadence), and each layout of the divider drag is sent at most four display periods after the grid began it, with a
// median of 2.5 and a 90th percentile of 3 (stepCommitDelays of @soksak/window-check/layout-timing.mjs), from the steps and the
// layout trace that diagnostics.drag answers. A run that misses either keeps the layout trace of its drag in the log folder as
// evidence (writeDragLayouts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, drag, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { commitCadence, displayPeriod, dragTrips, stepCommitDelays } from "@soksak/window-check/layout-timing.mjs";
import { fresh, joinedFailure } from "./fixture.mjs";
import { openFloorPage, prepareFloorDrag, VIEW_DRAG_PLAN, writeDragLayouts } from "./benchmark/cases/floor-page.mjs";
import { dragProcesses, NATIVE_DRAG_PLAN } from "./benchmark/cases/view-drag.mjs";
import { windowApplicationRows } from "../scripts/measure-app-usage.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: project-tab add control keeps its rectangle through the native and captured second drags`,
    { timeout: 180000 }, async (t) => {
      const s = await open(t, app);
      // The drags are measured under the default policy (prepareFloorDrag).
      await fresh(s, { measure: true });
      const floor = await openFloorPage(s);
      // Keep the benchmark default policy throughout the measured drags.
      await prepareFloorDrag(t, s, floor, app.configDir);
      const control = "core.project-tab.add";
      const rect = await s.rect(control);
      assert.ok(rect.width > 0 && rect.height > 0, `${control} has no visible area`);
      const logs = join(app.configDir, "logs");
      mkdirSync(logs, { recursive: true });
      const directory = mkdtempSync(join(logs, "workbench-capture-"));
      const offsets = currentEventOffsets(app.configDir);
      const evidence = { diagnostic: true, performanceAcceptance: false, control, rect,
        order: ["fresh", "prepareFloorDrag", "default policy", "process snapshot before", "native first drag", "process snapshot after", "captured second drag"],
        capture: null, events: [] };
      let failure;
      const processes = () => dragProcesses({ rows: async () => windowApplicationRows({
        configDir: app.configDir, statuses: [{ ...(await s.get("host.window")), window: s.window }] }) });
      try {
        evidence.processesBefore = await processes();
        await drag(s, NATIVE_DRAG_PLAN);
        evidence.processesAfter = await processes();
        const captured = await drag(s, VIEW_DRAG_PLAN, { capture: true });
        evidence.capture = captured;
        assert.deepEqual(await s.rect(control), rect, "the observed root control moved during the drag");
      } catch (error) {
        failure = error;
      }
      try {
        await s.flushLog();
        evidence.events = readEvents(app.configDir, offsets).events;
        evidence.failure = failure ? { message: failure.message, stack: failure.stack } : null;
        writeFileSync(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
        t.diagnostic(`root workbench capture evidence: ${directory}`);
      } catch (error) {
        if (failure) throw joinedFailure("workbench capture failed and its diagnostic evidence could not be saved", [failure, error]);
        throw error;
      }
      if (failure) throw failure;
    });

  test(`${app.name}: the commits of a view drag follow within two display refreshes and each is sent within four display periods`,
    { timeout: 180000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s, { measure: true });
      await prepareFloorDrag(t, s, await openFloorPage(s), app.configDir);
      await drag(s, NATIVE_DRAG_PLAN);
      const period = displayPeriod((await s.get("host.window")).refreshRate);
      const run = await drag(s, VIEW_DRAG_PLAN);
      const during = { from: run.ticks[0], to: run.ticks.at(-1), period };
      const commits = commitCadence(run.layouts, { ...during, trips: dragTrips(run) });
      const delays = stepCommitDelays(run.layouts, during);
      t.diagnostic(`${app.name}: display period ${period} ms, ${commits.count} commits, refreshes between them ` +
        `${JSON.stringify(commits.refreshes)}; delays median ${delays.median}, p90 ${delays.p90}, longest ${delays.longest} display ` +
        "periods");
      if (commits.failures.length > 0 || delays.failures.length > 0) {
        const logs = join(app.configDir, "logs");
        mkdirSync(logs, { recursive: true });
        const path = writeDragLayouts(mkdtempSync(join(logs, "view-drag-commits-")), run.layouts);
        t.diagnostic(`${app.name}: the layout trace of the drag from ${during.from} to ${during.to} ms: ${path}`);
      }
      assert.deepEqual(commits.failures, [], "the commits of the view drag");
      assert.deepEqual(delays.failures, [], "the layouts of the divider drag");
    });
}

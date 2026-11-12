// Functional root-chrome evidence under the benchmark default policy.
// Preserves the benchmark's fresh -> preparation -> native first drag -> captured
// second drag order on the floor page view of the view drag benchmark. It makes no performance acceptance claim.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, drag, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { fresh, joinedFailure } from "./fixture.mjs";
import { openFloorPage, prepareFloorDrag, VIEW_DRAG_PLAN } from "./benchmark/cases/floor-page.mjs";
import { dragProcesses, NATIVE_DRAG_PLAN } from "./benchmark/cases/view-drag.mjs";
import { execute, windowApplicationRows } from "../scripts/measure-app-usage.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: project-tab add control retains sampled contrast in every complete second-drag frame`,
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
      const processes = () => dragProcesses({ run: execute, rows: async () => windowApplicationRows({
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
}

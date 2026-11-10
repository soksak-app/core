// The view drag benchmark of B3 (docs/operations/examples.md, S5 and S16; cases/view-drag.mjs holds the order of its steps). It opens
// the floor page fixture view as the active tab of the focused card (cases/floor-page.mjs), prepares the layout of its drag, and runs
// under that layout a drag without capture through `diagnostics.drag` with `native: true`, the captured
// drag, which meets the performance targets with the performance trace off, and, after `frames` of host.window has not
// changed for 3 seconds, a drag without capture under the policy that stores the class `frame` at `debug`, whose U7 records it reads on a
// window whose host.window reports pageProcess null. It reads the CPU time and the peak footprint of each process of the application
// before and after the first drag. SOKSAK_ACCESSIBILITY=1 reads the elements of the window through the accessibility API before the
// drags; SOKSAK_GC_LOOP=1 turns `diagnostics.gc.loop` on around the third drag. B3 output (SOKSAK_B3_OUT and SOKSAK_B3_TRACE,
// cases/b3-run.mjs): the keys of view-drag in B3_MEASUREMENTS of measurements.mjs for the state, with the conditions read at the start
// of the interval of that state, which hold the settings of that state in B3_SETTINGS.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, drag, open } from "@soksak/window-check/app.mjs";
import { execute, untilFramesQuiet, windowApplicationRows } from "../../scripts/measure-app-usage.mjs";
import { applyTrace, FRAME_RECORDS } from "../../scripts/measure-trace.mjs";
import { fresh } from "../fixture.mjs";
import { readWindowElements } from "@soksak/window-check/hid.mjs";
import { b3Conditions, b3Target, fixtureSettings, withB3Out } from "./cases/b3-run.mjs";
import { openFloorPage, prepareFloorDrag, VIEW_DRAG_PLAN } from "./cases/floor-page.mjs";
import { recordGesture } from "./cases/gesture-records.mjs";
import { dragProcesses, NATIVE_DRAG_PLAN, runViewDrag, viewDragB3Values, viewDragOptions } from "./cases/view-drag.mjs";
import { B3_MEASUREMENTS, B3_SETTINGS } from "./measurements.mjs";

const OPTIONS = viewDragOptions(process.env);

for (const app of Object.values(APPS)) {
  test(`${app.name}: the view drag runs the drags of B3 in order, and its captured drag meets the performance targets with the traces off`,
    { timeout: 180000 }, async (t) => {
      const s = await open(t, app);
      await withB3Out(b3Target(process.env, B3_MEASUREMENTS["view-drag"]), async (run) => {
        await fresh(s, fixtureSettings(B3_SETTINGS["view-drag"]["0"]));
        const prepared = await prepareFloorDrag(t, s, await openFloorPage(s), app.configDir);
        const { pageProcess } = await s.get("host.window");
        await runViewDrag({ options: OPTIONS, pageProcess, steps: {
          readElements: async () => readWindowElements(app),
          conditions: async (state) => {
            const conditions = await b3Conditions(s, B3_SETTINGS["view-drag"][state]);
            if (run.state === state) run.conditions = conditions;
          },
          readProcesses: () => dragProcesses({ run: execute, rows: async () => windowApplicationRows({
            configDir: app.configDir, statuses: [{ ...(await s.get("host.window")), window: s.window }] }) }),
          nativeDrag: () => drag(s, NATIVE_DRAG_PLAN),
          firstDragRead: async (figures) => {
            t.diagnostic(`${app.name} first drag: ${JSON.stringify(figures)}`);
            if (run.state === "0") Object.assign(run.measurements, viewDragB3Values("0", { firstDrag: figures }));
          },
          capturedDrag: async () => {
            const result = await prepared.capture();
            const report = { ...result.report, layouts: result.drag.layouts };
            const path = join(result.directory, "result.json");
            writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
            t.diagnostic(`benchmark report ${path}: ${JSON.stringify(report.performance)}`);
            t.diagnostic(`transaction cadence (ms): ${JSON.stringify(report.transactionCadence)}`);
            assert.ok(report.frameCount > 30, "the benchmark has too few captured frames");
            return result;
          },
          untilFramesQuiet: () => untilFramesQuiet({ frames: async () => [(await s.get("host.window")).frames] }),
          frameRecords: () => applyTrace((name, params) => s.run(name, params), FRAME_RECORDS, app.configDir, { ended: s.client.ended }),
          gcLoop: (on) => s.request("diagnostics.gc.loop", { on }),
          uncapturedDrag: () => drag(s, VIEW_DRAG_PLAN),
          record: async (gesture) => {
            if (pageProcess === null) return recordGesture(s, gesture);
            await gesture();
            return null;
          },
          publish: async ({ elements, recorded }) => {
            if (elements !== null) t.diagnostic(`${app.name} accessibility elements: ${JSON.stringify(elements)}`);
            if (recorded !== null) t.diagnostic(`${app.name} third drag: ${recorded.records.length} U7 records`);
            if (run.state === FRAME_RECORDS) Object.assign(run.measurements, viewDragB3Values(FRAME_RECORDS, { recorded, gcLoop: OPTIONS.gcLoop }));
          },
        } });
      });
    });
}

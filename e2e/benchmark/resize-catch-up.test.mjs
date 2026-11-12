// Records a maximise and a restore (cases/resize.mjs), each of which ends with the layout at the window size, and reports the catch-up
// of each (catchUp of @soksak/window-check/layout-timing.mjs) as a diagnostic: e2e/resize.test.mjs judges it. The recordings are
// their log. On a window whose host.window reports pageProcess null it then runs a maximise and restore without capture under the trace
// state of the frame records, whose U7 records must be complete.
// Each state asserts the settings of B3_SETTINGS before it measures. B3 output (SOKSAK_B3_OUT and SOKSAK_B3_TRACE, cases/b3-run.mjs):
// the keys of resize-catch-up in B3_MEASUREMENTS of measurements.mjs for the state; the state captured writes the verdict with the
// conditions of the captured maximise and restore, and the state frame-records writes the U7 figures of the maximise without capture
// with its conditions.
import test from "node:test";

import { APPS, open, recordingSummary } from "@soksak/window-check/app.mjs";
import { catchUp } from "@soksak/window-check/layout-timing.mjs";
import { applyTrace, FRAME_RECORDS } from "../../scripts/measure-trace.mjs";
import { b3Conditions, b3Target, withB3Out } from "./cases/b3-run.mjs";
import { recordGesture } from "./cases/gesture-records.mjs";
import { recordMaximiseAndRestore, resizeB3Values, uncapturedResize, uncapturedResizeGestures } from "./cases/resize.mjs";
import { B3_MEASUREMENTS, B3_SETTINGS } from "./measurements.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: maximising and restoring keep the layout at the window size`, async (t) => {
    const s = await open(t, app);
    await withB3Out(b3Target(process.env, B3_MEASUREMENTS["resize-catch-up"]), async (run) => {
      const { pageProcess } = await recordMaximiseAndRestore(s, (gesture, { stopped, layouts, resizes }) => {
        t.diagnostic(`${app.name} ${gesture}: ${recordingSummary(stopped)}`);
        const caught = catchUp(layouts, resizes);
        t.diagnostic(`${app.name} ${gesture}: window resizes ${JSON.stringify(resizes)}, last size change at ${caught.last} ms, ` +
          `${layouts.length} layout transactions, the layout of ticket ${caught.ticket} at the window size ${caught.took} ms after ` +
          `the first resize; misses ` +
          `${JSON.stringify(caught.failures)}`);
      }, {
        started: async () => {
          const conditions = await b3Conditions(s, B3_SETTINGS["resize-catch-up"].captured);
          if (run.state === "captured") run.conditions = conditions;
        },
      });
      let recorded = null;
      if (pageProcess === null) {
        const gestures = await uncapturedResizeGestures(s);
        recorded = await uncapturedResize({
          frameRecords: async () => {
            await applyTrace((name, params) => s.run(name, params), FRAME_RECORDS, s.app.configDir, { ended: s.client.ended });
            const conditions = await b3Conditions(s, B3_SETTINGS["resize-catch-up"][FRAME_RECORDS]);
            if (run.state === FRAME_RECORDS) run.conditions = conditions;
          },
          record: (gesture) => recordGesture(s, gesture),
          maximise: gestures.maximise,
          restore: gestures.restore,
        });
        t.diagnostic(`${app.name}: the maximise and restore without capture have ${recorded.maximise.records.length} and ` +
          `${recorded.restore.records.length} U7 records`);
      }
      if (run.state !== null) Object.assign(run.measurements, resizeB3Values(run.state, { recorded }));
    });
  });
}

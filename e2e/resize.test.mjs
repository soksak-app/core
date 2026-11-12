// Records the maximize and restore of the window and checks that the app layout matches the window size after each change ends: the
// window reaches its size and the surfaces keep their distance to its right edge (recordMaximiseAndRestore of
// e2e/benchmark/cases/resize.mjs). Each change keeps the layout at the window size within 150 ms: the first layout transaction that
// begins at or after the last window resize event of the change that changed the content size is sent within 150 ms of its first
// window resize event (catchUp of @soksak/window-check/layout-timing.mjs, from the layout trace and the host.window.event records of
// kind resize with their content size). The recording of each change is its log.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open, recordingSummary } from "@soksak/window-check/app.mjs";
import { catchUp } from "@soksak/window-check/layout-timing.mjs";
import { recordMaximiseAndRestore } from "./benchmark/cases/resize.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: maximising and restoring settle with the layout at the window size within 150 ms`, async (t) => {
    const s = await open(t, app);
    await recordMaximiseAndRestore(s, (gesture, { stopped, layouts, resizes }) => {
      t.diagnostic(`${gesture}: ${recordingSummary(stopped)}`);
      const caught = catchUp(layouts, resizes);
      t.diagnostic(`${gesture}: window resizes ${JSON.stringify(resizes)}, last size change at ${caught.last} ms, ` +
        `${layouts.length} layout transactions, the layout of ticket ${caught.ticket} at the window size ${caught.took} ms after the ` +
        "first resize");
      assert.deepEqual(caught.failures, [], `the catch-up of ${gesture}`);
    });
  });
}

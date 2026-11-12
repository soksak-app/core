// Checks the verifier of the page while the boundary of a raster probe card is shaken. The recording of the drag is its evidence.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, drag, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { addRasterTabAt } from "./raster-probe.mjs";

/**
 * The boundaries to shake and the width.
 *
 * The initial layout of the example is fixed. The raster probe is in the first card of the middle column; x:2 and y:1 are boundaries
 * of that card. In both, the raster probe surface grows and shrinks. The pointer goes back and forth while pressed, so the boundary returns to its original position.
 * The boundary is designated by number and not by coordinate, so it does not miss when the window size differs.
 */
const PLANS = {
  "vertical boundary": { axis: "x", line: 2, dx: -250, dy: 0, ms: 48, times: 15 },
  "horizontal boundary": { axis: "y", line: 1, dx: 0, dy: 180, ms: 48, times: 15 },
};

for (const app of Object.values(APPS)) {
  for (const [which, plan] of Object.entries(PLANS)) {
    test(`${app.name}: shaking the ${which} exposes no unrendered area`, async (t) => {
      const s = await open(t, app);
      await fresh(s);
      await addRasterTabAt(s, 1, 0);
      // The verifier of the page runs at every render and publishes the result as core.verify. The check collects all results during the drag.
      const verify = await s.collect("core.verify");
      const run = await drag(s, plan, { capture: true });
      t.diagnostic(`recording ${run.frameDir}`);
      const verified = (await verify.stop()).filter(Boolean);
      assert.ok(verified.length > 0, "the page never reported a check");
      const failed = verified.filter((result) => result.failed > 0);
      assert.deepEqual(failed.map((result) => result.rows.filter((row) => !row.ok)), [],
        "the page reported a failed check");
    });
  }
}

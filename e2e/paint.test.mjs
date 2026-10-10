// Checks whether an unrendered area appears in the surface while the boundary is shaken.
//
// A web view renders only the area it laid out and fills the rest with white. The terminal surface and the card are both dark, so a white pixel
// adjoining the card color is an unrendered area.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, drag, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { terminalMarks } from "./outside.mjs";
import { bare, cardSize } from "./surface.mjs";

/**
 * The boundaries to shake and the width.
 *
 * The initial layout of the example is fixed. x:2 is the left boundary of the terminal card and y:1 is the boundary below it.
 * In both, the terminal surface grows and shrinks. The pointer goes back and forth while pressed, so the boundary returns to its original position.
 * The boundary is designated by number and not by coordinate, so it does not miss when the window size differs.
 */
const PLANS = {
  "vertical boundary": { axis: "x", line: 2, dx: -250, dy: 0, ms: 48, times: 15 },
  "horizontal boundary": { axis: "y", line: 1, dx: 0, dy: 180, ms: 48, times: 15 },
};

/**
 * The change (points) of the width or the height of the terminal card by which the boundary counts as moved.
 *
 * If the boundary sits at the minimum card size, this value is close to 0, and the rendering check then passes
 * without checking anything, so the check first confirms in the recording that the boundary actually moved. The two drags move by at least 180pt.
 */
const MOVED = 100;

for (const app of Object.values(APPS)) {
  for (const [which, plan] of Object.entries(PLANS)) {
    test(`${app.name}: shaking the ${which} exposes no unrendered area`, async (t) => {
      const s = await open(t, app);
      if (!s) return t.skip(`${app.binary} is not built`);
      await fresh(s);
      const marks = await terminalMarks(s);
      // The verifier of the page runs at every render and publishes the result as core.verify. The check collects all results during the drag.
      const verify = await s.collect("core.verify");
      const run = await drag(t, s, plan, { capture: true });
      const verified = (await verify.stop()).filter(Boolean);
      assert.ok(verified.length > 0, "the page never reported a check");
      const failed = verified.filter((result) => result.failed > 0);
      assert.deepEqual(failed.map((result) => result.rows.filter((row) => !row.ok)), [],
        "the page reported a failed check");

      const files = frames(run.frames);
      assert.ok(files.length > 60, `only ${files.length} frames were recorded`);
      let worst = { n: 0, frame: -1 };
      let seen = 0;
      let least = { width: Infinity, height: Infinity };
      let most = { width: 0, height: 0 };
      let measured = 0;
      files.forEach((path, index) => {
        const frame = readFrame(path);
        const n = bare(frame);
        if (n > 0) seen++;
        if (n > worst.n) worst = { n, frame: index };
        const size = cardSize(frame, { x: marks.cx, y: marks.head });
        if (!size) return;
        measured++;
        for (const key of ["width", "height"]) {
          least[key] = Math.min(least[key], size[key]);
          most[key] = Math.max(most[key], size[key]);
        }
      });
      assert.equal(measured, files.length, `the terminal card was measured in only ${measured} of ${files.length} frames`);
      const moved = Math.max(most.width - least.width, most.height - least.height);
      assert.ok(moved >= MOVED,
        `the terminal card changed by ${moved}pt while the boundary was shaken, so the boundary did not move`);
      assert.equal(worst.n, 0,
        `${seen} of ${files.length} frames show unrendered area; the worst is ${worst.n} pixels in frame ${worst.frame}`);
    });
  }
}

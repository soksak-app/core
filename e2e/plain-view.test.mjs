// The drawing of a view without plugin code, judged from the content frames that the view traces (plugin.probeplain.view.content_frame,
// mapped to the clock of diagnostics.clock), the steps of diagnostics.drag and the layout trace of diagnostics.layout.trace
// (docs/spec/plugin-processes.md, (v) and (viii)): during a drag of the right edge of its card the content frames follow one another
// within 40 ms (contentCadence), a final size that differs from the last size of the drag is drawn within 40 ms after the last step
// (contentConvergence), and after the card becomes 80 pt wider the view draws its new size within 100 ms of the first layout of that
// change that was sent (contentAfterChange of @soksak/window-check/layout-timing.mjs). The drag records nothing.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { contentAfterChange, contentCadence, contentConvergence } from "@soksak/window-check/layout-timing.mjs";
import { fresh } from "./fixture.mjs";
import { dragAndWiden, openPlainView } from "./benchmark/cases/plain-view.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a view without plugin code draws within 40 ms during a drag and its new size within 100 ms of a card change`,
    { timeout: 120000 }, async (t) => {
      const s = await open(t, app);
      const opened = await openPlainView(s,
        () => fresh(s, { log: { frame: "trace" }, reads: ["plugin.probeplain.view.content_frame"] }));
      const traced = await dragAndWiden(t, s, opened);
      const { dragged, changed } = traced.action;
      const [from, end] = [dragged.ticks[0], dragged.ticks.at(-1)];
      const cadence = contentCadence(traced.contentFrames, { from, to: end });
      // The frames of the card change are not frames of the drag.
      const converged = contentConvergence(traced.contentFrames.filter(({ timeRange }) => changed === null
        || timeRange.upperMs < changed), { end });
      t.diagnostic(`${app.name}: content intervals ${JSON.stringify(cadence.intervals)} ms; final size ` +
        (converged.applicable ? `${converged.took} ms after the drag` : "equal to the last size of the drag"));
      assert.deepEqual([...cadence.failures, ...converged.failures], [], "the content frames of the drag");
      assert.ok(changed !== null, "the card size change sent no layout");
      const after = contentAfterChange(traced.contentFrames, { changedAt: changed });
      t.diagnostic(`${app.name}: the new size of the card ${after.took} ms after the first layout of the change`);
      assert.deepEqual(after.failures, [], "the content frames of the card size change");
    });
}

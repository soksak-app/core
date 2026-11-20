// Counts, for each layout action and each of six raster probe cards, the recorded frames in which the image region of the card shows
// no pixel of its raster (cases/layout-redraw.mjs, docs/operations/examples.md#layout-redraw-benchmark). It reports the counts and
// judges none: the stills are evidence that no check judges (docs/spec/diagnostics.md).
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { runRedraw } from "./cases/layout-redraw.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: the frames of six image region cards during a balance, a divider drag and a leader change report blank cards`,
    { timeout: 600000 }, async (t) => {
      const s = await open(t, app);
      const { leader, frames, actions } = await runRedraw(s);
      t.diagnostic(`${app.name}: ${frames} recorded frames; core.group.leader ${leader ? "declared" : "not declared, no leader action"}`);
      for (const { action, frames: during, cards } of actions) {
        const blank = cards.reduce((sum, { blank: count }) => sum + count, 0);
        t.diagnostic(`${app.name}: ${action}: ${during} frames, ${blank} blank card frames; ` +
          cards.map(({ card, blank: count, fewestShare }) => `${card} ${count} blank, fewest ${(fewestShare * 100).toFixed(0)}%`).join("; "));
      }
    });
}

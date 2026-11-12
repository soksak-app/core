// Records the maximize and restore of the window and checks that the app layout matches the window size after each change ends: the
// window reaches its size and the surfaces keep their distance to its right edge (recordMaximiseAndRestore of
// e2e/benchmark/cases/resize.mjs). The recording of each change is its evidence.
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { recordMaximiseAndRestore } from "./benchmark/cases/resize.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: maximising and restoring settle with the layout at the window size`, async (t) => {
    const s = await open(t, app);
    await recordMaximiseAndRestore(s, (gesture, { frames, missed, late }) =>
      t.diagnostic(`${gesture}: recording ${frames}, ${missed} missed and ${late} late stills`));
  });
}

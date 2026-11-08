// An idle tab with a document region (a layout probe tab) settles, and the footprints of its documents and the growth of the process that draws the
// window (the main web view, or the host process of a window without a page process) are measured.
// The measured cost is written to the diagnostic of the check; its limit is judged by the benchmark (e2e/benchmark/idle-tab.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { recordIdleTab } from "./benchmark/cases/idle-tab.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: an idle tab with a document region settles and its documents are counted`, { timeout: 300000 }, async (t) => {
    const s = await open(t, app);
    const { settled, growthOf, growthBefore, growthAfter, growth, cost } = await recordIdleTab(s);
    assert.ok(settled > 0, `${app.name}: the documents of the tab were counted as ${settled} KB`);
    t.diagnostic(`documents ${settled} KB; ${growthOf} ${growthBefore} -> ${growthAfter} KB (${growth} KB); cost ${cost} KB`);
  });
}

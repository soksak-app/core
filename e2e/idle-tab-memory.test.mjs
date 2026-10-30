// An idle browser tab on a blank page settles, and the footprints of its documents and the growth of the main web view are measured.
// The measured cost is written to the diagnostic of the check; its limit is judged by the benchmark (e2e/benchmark/idle-tab.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { recordIdleTab } from "./benchmark/cases/idle-tab.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: an idle browser tab on a blank page settles and its documents are counted`, { timeout: 300000 }, async (t) => {
    const s = await open(t, app);
    const { settled, mainBefore, mainAfter, growth, cost } = await recordIdleTab(s);
    assert.ok(settled > 0, `${app.name}: the documents of the tab were counted as ${settled} KB`);
    t.diagnostic(`documents ${settled} KB; main web view ${mainBefore} -> ${mainAfter} KB (${growth} KB); cost ${cost} KB`);
  });
}

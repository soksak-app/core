// The shared cases of the activities of a window (docs/spec/cases/activity.json, docs/spec/activity.md). The Go workbench of
// packages/workbench-mygo runs the same file, so a case is one statement that both workbenches meet.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tabActivity, windowActivity } from "../activity.js";

const table = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/activity.json", import.meta.url), "utf8"));

for (const kase of table.tabs) {
  test(`activity of a tab: ${kase.name}`, { timeout: 5000 }, () => {
    assert.deepEqual(tabActivity(kase.plugin, kase.tab, kase.statuses), kase.returns);
  });
}

for (const kase of table.windows) {
  test(`activity of a window: ${kase.name}`, { timeout: 5000 }, () => {
    assert.deepEqual(windowActivity(kase.projects, kase.tabs), kase.returns);
  });
}

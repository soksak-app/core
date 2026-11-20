// The shared cases of the project activity record of the application (docs/spec/cases/activity.json, records;
// docs/spec/activity.md#activity-of-a-project). The record of packages/workbench/activity.js serves the browser runtime, and the Go and
// the Rust host run the same cases, so a case is one statement that each record meets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createProjectActivities } from "../activity.js";

const table = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/activity.json", import.meta.url), "utf8"));

for (const kase of table.records) {
  test(`project activity record: ${kase.name}`, { timeout: 5000 }, () => {
    const record = createProjectActivities();
    for (const [index, step] of kase.steps.entries()) {
      let error = null;
      try {
        if (step.publish) record.publish(step.publish.window, step.publish.owner, step.publish.id, step.publish.spaces);
        else if (step.release) record.release(step.release.id);
        else record.end(step.end.window);
      } catch (thrown) {
        error = thrown.message;
      }
      assert.equal(error, step.error, `step ${index}`);
      assert.deepEqual(record.record(), step.record, `step ${index}`);
    }
  });
}

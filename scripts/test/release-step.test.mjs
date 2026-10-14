// The release step script that the release workflow runs on a release-built host (F191,
// docs/spec/installation.md#stored-data-migration): the script itself is the step, and this test holds its text to the
// contract, so the workflow step and the local verification cannot drift apart.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(new URL("../release-step.sh", import.meta.url), "utf8");

test("the release step script writes the released form, runs the host once and requires the migration and its record", () => {
  assert.match(script, /"format":2/, "the script writes the released format-2 form");
  assert.match(script, /--config-dir/, "the script runs the host once");
  assert.match(script, /"event":"log.open"/, "the script waits for the first host log line");
  assert.match(script, /"event":"log.migrated"/, "the script requires the migration record");
  assert.match(script, /"format": ?3/, "the script requires the migrated file");
  assert.doesNotMatch(script, /\\btimeout\\b/, "the macOS runner has no timeout command; the loop and the kill bound the run");
});

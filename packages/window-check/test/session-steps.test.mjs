// A window check writes each step it starts with its elapsed time, so a check that its test time limit ends names the
// step that ran (F118).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The tracked program of the run: a check file that node:test runs in a process of its own.
const probe = fileURLToPath(new URL("../fixtures/session-probes/steps.mjs", import.meta.url));

// The probe check waits on a status that never changes and ends at its own test time limit. node:test reports the
// test limit, so this check runs the probe in a separate node:test run without its own context (NODE_TEST_CONTEXT).
function run() {
  const { NODE_TEST_CONTEXT, ...environment } = process.env;
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", probe],
    { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: "0" } });
}

test("a check that its test limit ends names the steps it started", { timeout: 30000 }, () => {
  const result = run();
  const output = result.stdout + result.stderr;
  assert.match(output, /test timed out after 300ms/, output);
  assert.match(output, /step probe \+\d+\.\d s status\.get core\.project/, output);
  assert.match(output, /step probe \+\d+\.\d s until probe\.document/, output);
});

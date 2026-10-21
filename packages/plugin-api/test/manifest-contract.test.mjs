// Runs published ordered manifest validation calls against the core implementation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateManifest } from "../index.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/manifest.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "manifest.accepts-declared-sections",
  "manifest.refuses-reserved-core-id",
  "manifest.refuses-unknown-field",
];

export function runManifestCase(testCase) {
  return testCase.steps.map((step) => {
    try {
      return { accepted: true, result: validateManifest(step.call.manifest) };
    } catch (error) {
      return { accepted: false, error: error.message };
    }
  });
}

test("manifest validator publishes acceptance and refusal cases", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test('manifest validator ' + testCase.id + ' matches each ordered call', () => {
    assert.deepEqual(runManifestCase(testCase), testCase.steps.map(({ output }) => output));
  });
}

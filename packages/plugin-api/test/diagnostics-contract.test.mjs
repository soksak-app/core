// Runs published ordered diagnostics validation calls against the core implementation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateDiagnostics } from "../index.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/diagnostics.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "diagnostics.accepts-declared-extension",
  "diagnostics.refuses-duplicate-name",
  "diagnostics.refuses-without-surface",
  "diagnostics.refuses-invalid-module-path",
  "diagnostics.refuses-unknown-field",
];

export function runDiagnosticsCase(testCase) {
  return testCase.steps.map((step) => {
    try {
      const { manifest, diagnostics } = step.call;
      return { accepted: true, result: validateDiagnostics(manifest, diagnostics) };
    } catch (error) {
      return { accepted: false, error: error.message };
    }
  });
}

test("diagnostics validator publishes acceptance and refusal cases", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test("diagnostics validator " + testCase.id + " matches each ordered call", () => {
    assert.deepEqual(runDiagnosticsCase(testCase), testCase.steps.map(({ output }) => output));
  });
}

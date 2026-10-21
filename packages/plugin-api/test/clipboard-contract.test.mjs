// Runs the ordered shellQuotePath contract cases against the core implementation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { shellQuotePath } from "../clipboard.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/clipboard.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "clipboard.shell-quote-path.with-spaces",
  "clipboard.shell-quote-path.embedded-single-quote",
  "clipboard.shell-quote-path.dropped-file",
  "clipboard.shell-quote-path.refuses-empty",
];

export function runClipboardCase(testCase) {
  const outputs = [];
  for (const step of testCase.steps) {
    assert.ok(step && typeof step === "object" && !Array.isArray(step), `${testCase.id}: step must be an object`);
    assert.deepEqual(Object.keys(step).filter((key) => key !== "output"), ["quote"], `${testCase.id}: each step has one operation`);
    try { outputs.push({ path: shellQuotePath(step.quote.path) }); }
    catch (error) { outputs.push({ error: error.message }); }
  }
  return outputs;
}

test("clipboard publishes ordered shellQuotePath cases", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test("clipboard " + testCase.id + " matches each step", () => {
    assert.deepEqual(runClipboardCase(testCase), testCase.steps.map(({ output }) => output));
  });
}

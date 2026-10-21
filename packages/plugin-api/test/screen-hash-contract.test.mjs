// Runs ordered published screenHash cases against the core implementation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { screenBytes, screenFromMessage, screenHash } from "../screen-hash.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/screen-hash.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "screen.bytes.canonical-order",
  "screen.hash.sha256",
  "screen.message.projects-hashed-fields",
  "screen.refusal.names-invalid-member",
];

export async function runScreenHashCase(testCase) {
  const outputs = [];
  for (const step of testCase.steps) {
    try {
      if (step.bytes) {
        outputs.push({ bytes: Buffer.from(screenBytes(step.bytes.screen)).toString("hex") });
      } else if (step.hash) {
        outputs.push({ hash: await screenHash(step.hash.screen) });
      } else if (step.message) {
        outputs.push({ screen: screenFromMessage(step.message.value) });
      } else {
        assert.fail(testCase.id + ": unknown step");
      }
    } catch (error) {
      outputs.push({ error: error.message });
    }
  }
  return outputs;
}

test("screenHash publishes ordered canonicalization, message, and refusal cases", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test('screenHash ' + testCase.id + ' matches each ordered step', async () => {
    assert.deepEqual(await runScreenHashCase(testCase), testCase.steps.map(({ output }) => output));
  });
}

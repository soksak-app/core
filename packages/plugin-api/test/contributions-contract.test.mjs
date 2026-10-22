// Runs the published contribution cases (packages/plugin-api/contract/contributions.json) against resolveContributions of core.
// Each case gives the installed plugins and the resolved items that the implementation must return, in order.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveContributions } from "../index.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/contributions.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "contributions.resolve.connects-a-matching-item",
  "contributions.resolve.reports-a-missing-provider",
  "contributions.resolve.reports-an-undeclared-point",
  "contributions.resolve.reports-a-provider-without-extension-points",
  "contributions.resolve.reports-a-range-mismatch",
  "contributions.resolve.reports-a-schema-mismatch",
  "contributions.resolve.orders-by-plugin-point-and-index",
  "contributions.resolve.plugin-without-contributes-adds-nothing",
];

test("contributions contract publishes the required cases in order", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`contributions ${testCase.id} resolves to the published items`, () => {
    assert.deepEqual(resolveContributions(structuredClone(testCase.installed)), testCase.output);
  });
}

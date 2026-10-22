// Runs the published view page cases (packages/plugin-api/contract/view-page.json) against insertViewImportMap. A case with
// output checks the page after the insertion; a case with error checks the reason of the refusal. The native handler runs the
// same cases, so both implementations give one result.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VIEW_IMPORTS } from "../index.js";
import { insertViewImportMap } from "../view-page.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/view-page.json", import.meta.url), "utf8"));

test("the published map text is the JSON of VIEW_IMPORTS", () => {
  assert.equal(CONTRACT.map, JSON.stringify({ imports: VIEW_IMPORTS }));
});

for (const testCase of CONTRACT.cases) {
  test(`view page insertion ${testCase.name}`, () => {
    const map = testCase.map ?? CONTRACT.map;
    if (testCase.error !== undefined) {
      assert.throws(() => insertViewImportMap(testCase.input, map), { message: testCase.error });
    } else {
      assert.equal(insertViewImportMap(testCase.input, map), testCase.output);
    }
  });
}

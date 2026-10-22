// Replays every case of the manifest case table against validateManifest. A case with `accepted` true must pass, and a case
// with `error` must throw exactly that text (docs/spec/installation.md#plugin-release).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateManifest } from "../index.js";

const TABLE = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/manifest-validation.json", import.meta.url), "utf8"));

for (const testCase of TABLE.cases) {
  test(`manifest validation ${testCase.id}`, () => {
    let error = null;
    try {
      validateManifest(structuredClone(testCase.manifest));
    } catch (thrown) {
      error = thrown.message;
    }
    if (testCase.accepted) {
      assert.equal(error, null);
    } else {
      assert.equal(error, testCase.error);
    }
  });
}

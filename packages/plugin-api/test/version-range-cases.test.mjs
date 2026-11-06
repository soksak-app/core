// Replays every case of the version range table (docs/spec/cases/version-ranges.json) against rangeContains, and compares versions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compareVersions, rangeContains } from "../index.js";

const TABLE = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/version-ranges.json", import.meta.url), "utf8"));

test("a range contains each version of the version range case table as the table states", () => {
  assert.ok(TABLE.contains.length > 0);
  for (const { range, version, inside } of TABLE.contains) {
    assert.equal(rangeContains(range, version), inside, `range ${range} contains ${version}`);
  }
});

test("each range that the version range case table refuses is an invalid range", () => {
  assert.ok(TABLE.refused.length > 0);
  for (const range of TABLE.refused) {
    assert.throws(() => rangeContains(range, "0.0.0"), (error) => error.message === `invalid range ${range}`, `range ${JSON.stringify(range)}`);
  }
});

test("versions compare by number, and a version of another form is an error", () => {
  assert.ok(compareVersions("0.0.10", "0.0.9") > 0);
  assert.ok(compareVersions("1.0.0", "0.9.9") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.throws(() => compareVersions("next", "1.0.0"), /^Error: version next must be x\.y\.z with numeric parts and no leading zeros$/);
});

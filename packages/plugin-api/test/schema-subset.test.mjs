// The schema subset of exposure declarations (docs/spec/exposure.md#entry-fields): matchesSchema replays every case of
// docs/spec/cases/schema-subset.json, which the Go and Rust matchers of sok also replay.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { matchesSchema } from "../index.js";

const { cases } = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/schema-subset.json", import.meta.url), "utf8"));

test("matchesSchema matches each value of the schema subset cases exactly when the case says so", { timeout: 5000 }, () => {
  assert.ok(cases.length > 0, "the schema subset case table holds no case");
  for (const { id, schema, value, matches } of cases) assert.equal(matchesSchema(schema, value), matches, id);
});

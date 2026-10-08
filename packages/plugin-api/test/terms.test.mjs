import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { terms } = JSON.parse(readFileSync(new URL("../terms.json", import.meta.url), "utf8"));

test("each term has a definition and a list of rejected synonyms", () => {
  assert.ok(terms.length > 0);
  for (const entry of terms) {
    assert.deepEqual(Object.keys(entry).sort(), ["allowed", "definition", "rejected", "term"], JSON.stringify(entry));
    assert.ok(typeof entry.term === "string" && entry.term !== "", JSON.stringify(entry));
    assert.ok(typeof entry.definition === "string" && entry.definition !== "", JSON.stringify(entry));
    assert.ok(Array.isArray(entry.rejected) && entry.rejected.every((word) => typeof word === "string" && word !== ""), JSON.stringify(entry));
    assert.ok(Array.isArray(entry.allowed) && entry.allowed.every((name) => typeof name === "string" && name !== ""), JSON.stringify(entry));
  }
});

test("a term is listed once and is no rejected synonym", () => {
  const names = terms.map((entry) => entry.term.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  const rejected = terms.flatMap((entry) => entry.rejected.map((word) => word.toLowerCase()));
  assert.equal(new Set(rejected).size, rejected.length);
  for (const word of rejected) assert.ok(!names.includes(word), `${word} is a term and a rejected synonym`);
});

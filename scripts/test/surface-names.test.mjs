// The gate of the core names of the mygo workbench leaves the names of surfaceNames to the document of each view. Those are
// the names that the document of a view holds, and the exposure declares them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("the names that the mygo workbench leaves to a view are the names that its document holds", () => {
  const literal = read("packages/workbench-mygo/src/surfaces.go").match(/surfaceNames = map\[string\]bool\{([^}]*)\}/);
  assert.ok(literal, "surfaces.go holds no surfaceNames");
  const left = [...literal[1].matchAll(/"([^"]+)": true/g)].map((match) => match[1]).sort();
  const held = read("packages/plugin-api/surface-document.js").match(/const NAMES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(held, "surface-document.js holds no NAMES");
  assert.deepEqual(left, [...held[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort());
  const { exposes } = JSON.parse(read("packages/workbench/exposure.json"));
  const declared = [...exposes.status, ...exposes.commands].map((entry) => entry.name);
  assert.deepEqual(left.filter((name) => !declared.includes(name)), []);
});

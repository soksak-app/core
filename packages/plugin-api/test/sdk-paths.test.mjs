// The published modules of the SDK run in plugin repositories, which do not hold this checkout's layout. No module names a
// folder of this repository through a `packages/` path, whether in a string, a comment or a pattern (decision of F258-4).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const CORE_FOLDER = /packages[\\/]/;

for (const file of PACKAGE.files.filter((item) => /\.m?js$/.test(item))) {
  test(`published SDK module ${file} names no packages path`, () => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const lines = source.split("\n").flatMap((line, index) => (CORE_FOLDER.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : []));
    assert.deepEqual(lines, []);
  });
}

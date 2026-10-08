// A module that the page imports and that package.json does not list in its file list is not staged into the application, so
// its request fails and the main page does not start.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const here = new URL("../", import.meta.url);
const listed = new Set(JSON.parse(readFileSync(new URL("package.json", here), "utf8")).files);

/** The relative imports of a source text, as file names of this folder. */
function importsOf(text) {
  const names = new Set();
  for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*|^import\s+)["']\.\/([^"'/]+\.(?:js|json|css))["']/gm)) names.add(match[1]);
  return names;
}

test("every file that the start document and the modules of the page import is listed in package.json files", () => {
  const sources = ["index.html", ...listed].filter((name) => /\.(?:js|html)$/.test(name) && existsSync(new URL(name, here)));
  const missing = [];
  for (const name of sources) {
    for (const imported of importsOf(readFileSync(new URL(name, here), "utf8"))) {
      if (!listed.has(imported) && existsSync(new URL(imported, here))) missing.push(`${name} imports ${imported}`);
    }
  }
  assert.deepEqual(missing, [], "these imports are not staged because package.json files does not list them");
});

test("every top-level module of this folder that a listed file imports is a file of the folder", () => {
  const folder = new Set(readdirSync(here));
  for (const name of listed) assert.ok(folder.has(name.split("/")[0]), `package.json files lists ${name}, which is not in the folder`);
});

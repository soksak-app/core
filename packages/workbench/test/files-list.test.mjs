// A module that the page imports and that package.json does not list in its file list is not staged into the application, so
// its request fails and the main page does not start.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = new URL("../", import.meta.url);
const STAGE = fileURLToPath(new URL("../copy-frontend.mjs", import.meta.url));
const listed = new Set(JSON.parse(readFileSync(new URL("package.json", here), "utf8")).files);

/** The relative imports of a source text, as file names of this folder. */
function importsOf(text) {
  const names = new Set();
  for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*|^import\s+)["']\.\/([^"'/]+\.(?:js|json|css))["']/gm)) names.add(match[1]);
  return names;
}

test("every file that the start document and the modules of the page import is listed in package.json files", () => {
  const app = mkdtempSync(join(tmpdir(), "soksak-workbench-import-stage-"));
  try {
    cpSync(fileURLToPath(new URL("fixtures/stage-app/", import.meta.url)), app, { recursive: true });
    cpSync(fileURLToPath(new URL("fixtures/stage-app-probe/", import.meta.url)), app, { recursive: true });
    const configuration = join(app, "configuration");
    cpSync(fileURLToPath(new URL("fixtures/stage-app-installed/", import.meta.url)), configuration, { recursive: true });
    execFileSync(process.execPath, [STAGE, "out", "--installed", configuration], { cwd: app, encoding: "utf8" });

    const output = join(app, "out");
    const pending = ["index.html", ...[...listed].filter((name) => /\.(?:js|html)$/.test(name))];
    const visited = new Set();
    for (let position = 0; position < pending.length; position += 1) {
      const name = pending[position];
      if (visited.has(name)) continue;
      visited.add(name);
      const source = join(output, name);
      assert.ok(existsSync(source), `staged page entry imports missing module ${name}`);
      for (const imported of importsOf(readFileSync(source, "utf8"))) {
        const child = join(dirname(name), imported);
        const staged = join(output, child);
        assert.ok(existsSync(staged), `${name} imports ${imported}, but ${child} is absent from the staged serving payload`);
        if (/\.(?:js|html)$/.test(child)) pending.push(child);
      }
    }
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test("every top-level module of this folder that a listed file imports is a file of the folder", () => {
  const folder = new Set(readdirSync(here));
  for (const name of listed) assert.ok(folder.has(name.split("/")[0]), `package.json files lists ${name}, which is not in the folder`);
});

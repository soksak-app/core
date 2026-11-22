// No source of the hosts or of the mygo workbench starts sudo, so no operation of the application needs administrator rights
// (docs/spec/cli.md#agents-in-the-application). The test of packages/sok/go judges the sources of the command line.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url).pathname;
const FOLDERS = [
  ["packages/host/go/src", ".go", '"sudo"'],
  ["packages/host/rust/src", ".rs", '"sudo"'],
  ["packages/workbench-mygo/src", ".go", '"sudo"'],
];

function sources(folder, extension) {
  return readdirSync(join(ROOT, folder), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(entry.parentPath, entry.name));
}

// contract: cli.no-administrator-rights
test("no source of the hosts or of the mygo workbench starts sudo", { timeout: 5000 }, () => {
  const named = [];
  for (const [folder, extension, literal] of FOLDERS) {
    const files = sources(folder, extension);
    assert.ok(files.length > 0, `${folder} holds no ${extension} source`);
    for (const file of files) if (readFileSync(file, "utf8").includes(literal)) named.push(file.slice(ROOT.length));
  }
  assert.deepEqual(named, [], "a source names the sudo command");
});

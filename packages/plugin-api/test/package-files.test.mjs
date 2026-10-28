import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const contractRoot = join(packageRoot, "contract");

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    assert.ok(entry.isFile(), `${relative(packageRoot, path)} must be a regular package contract file`);
    return [relative(packageRoot, path).split(sep).join("/")];
  });
}

test("the packed SDK contains every current contract file", () => {
  const contractFiles = filesUnder(contractRoot);
  assert.ok(contractFiles.length > 0, "the SDK has no contract files to package");
  const destination = mkdtempSync(join(tmpdir(), "soksak-plugin-api-pack-"));
  try {
    const output = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    const [pack] = JSON.parse(output);
    assert.equal(typeof pack?.filename, "string", "npm pack did not report its release filename");
    const releaseFile = join(destination, pack.filename);
    assert.ok(statSync(releaseFile).isFile(), "npm pack did not create its release file");
    const entries = execFileSync("tar", ["-tzf", releaseFile], { encoding: "utf8" }).trim().split("\n");
    for (const file of contractFiles) {
      assert.ok(entries.includes(`package/${file}`), `${file} is missing from the packed SDK release`);
    }
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});

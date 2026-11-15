import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "es-module-lexer/js";
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

test("the packed SDK contains every current contract file", { timeout: 15000 }, () => {
  const contractFiles = filesUnder(contractRoot);
  assert.ok(contractFiles.length > 0, "the SDK has no contract files to package");
  const destination = mkdtempSync(join(tmpdir(), "soksak-plugin-api-pack-"));
  try {
    const output = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 10000,
    });
    const [pack] = JSON.parse(output);
    assert.equal(typeof pack?.filename, "string", "npm pack did not report its release filename");
    const releaseFile = join(destination, pack.filename);
    assert.ok(statSync(releaseFile).isFile(), "npm pack did not create its release file");
    const entries = execFileSync("tar", ["-tzf", releaseFile], { encoding: "utf8", timeout: 5000 }).trim().split("\n");
    for (const file of contractFiles) {
      assert.ok(entries.includes(`package/${file}`), `${file} is missing from the packed SDK release`);
    }
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});

test("the plugin API ships no record check, release gate, checklist reader or term list", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.bin?.["sok-check"], undefined);
  for (const file of ["checklist.js", "commits.js", "records.js", "release.js", "terms.json"]) {
    assert.ok(!manifest.files.includes(file), file);
    assert.ok(!existsSync(join(packageRoot, file)), file);
  }
  assert.equal(manifest.exports["./records"], undefined);
});

test("the plugin API ships no event source check or event source rules", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.bin?.["sok-check"], undefined);
  for (const file of ["events.js", "event-rules.json"]) {
    assert.ok(!manifest.files.includes(file), file);
    assert.ok(!existsSync(join(packageRoot, file)), file);
  }
  assert.equal(manifest.dependencies?.ajv, undefined, "only the event source check used ajv");
});

test("the plugin API has no command, and it exports the exposure check that the registry reads from each core release", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.bin, undefined);
  assert.equal(manifest.exports["./exposure-check"], "./exposure-check.js");
  for (const file of ["exposure-check.js", "core-exposure.json"]) {
    assert.ok(manifest.files.includes(file), file);
    assert.ok(existsSync(join(packageRoot, file)), file);
  }
  for (const file of ["engines-check.js", "view-check.js"]) {
    assert.ok(!manifest.files.includes(file), file);
    assert.ok(!existsSync(join(packageRoot, file)), file);
  }
});

// The view test host is published: a plugin test imports it from the installed release, so every module that an export
// reaches by a static import is in the release file, and the test host resolves from an installed copy.
test("the release file of the plugin API holds every module that an export reaches by a static import", { timeout: 15000 }, () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const destination = mkdtempSync(join(tmpdir(), "soksak-plugin-api-closure-"));
  try {
    const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 10000,
    }));
    const entries = new Set(execFileSync("tar", ["-tzf", join(destination, pack.filename)], { encoding: "utf8", timeout: 5000 })
      .trim().split("\n"));
    const targets = Object.entries(manifest.exports).filter(([key]) => key !== "./package.json").map(([, target]) => target);
    for (const target of ["./testing.js", "./view-host.js", "./view-answer.js", "./view-events.js", "./view-commands.js", "./command-route.js"]) {
      assert.ok(targets.includes(target), `${target} is not an export of @soksak/plugin-api`);
    }
    const missing = [];
    const seen = new Set();
    const pending = targets.map((target) => target.slice(2));
    while (pending.length > 0) {
      const file = pending.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      if (!entries.has(`package/${file}`)) {
        missing.push(file);
        continue;
      }
      const text = execFileSync("tar", ["-xzOf", join(destination, pack.filename), `package/${file}`], { encoding: "utf8" });
      const [imports] = parse(text, file);
      for (const entry of imports) {
        const specifier = entry.specifier;
        if (typeof specifier !== "string" || !specifier.startsWith(".")) continue;
        pending.push(posix.normalize(posix.join(posix.dirname(file), specifier)));
      }
    }
    assert.deepEqual(missing, [], "modules reached by a static import of an export are missing from the packed release");
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});

test("an installed copy of the plugin API release resolves @soksak/plugin-api/testing with jsdom from the consumer", { timeout: 60000 }, () => {
  const work = mkdtempSync(join(tmpdir(), "soksak-plugin-api-install-"));
  try {
    const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 10000,
    }));
    const consumer = join(work, "consumer");
    const scope = join(consumer, "node_modules", "@soksak", "plugin-api");
    mkdirSync(scope, { recursive: true });
    execFileSync("tar", ["-xzf", join(work, pack.filename), "-C", scope, "--strip-components=1"]);
    const probe = ["--input-type=module", "-e", 'await import("@soksak/plugin-api/testing"); console.log("resolved")'];
    // The consumer installs jsdom: the optional peer resolves from the consumer's node_modules.
    symlinkSync(join(packageRoot, "node_modules", "jsdom"), join(consumer, "node_modules", "jsdom"), "dir");
    symlinkSync(join(packageRoot, "node_modules", "es-module-lexer"), join(consumer, "node_modules", "es-module-lexer"), "dir");
    assert.equal(execFileSync(process.execPath, probe, { cwd: consumer, encoding: "utf8" }).trim(), "resolved");
    // Without jsdom the import fails, and the error names jsdom.
    rmSync(join(consumer, "node_modules", "jsdom"));
    const failure = spawnSync(process.execPath, probe, { cwd: consumer, encoding: "utf8" });
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /Cannot find package 'jsdom'/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

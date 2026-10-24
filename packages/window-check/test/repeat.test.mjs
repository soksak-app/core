// Checks that the window check repeat tool counts the checks that ran regardless of the output color.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repeat = fileURLToPath(new URL("../repeat.mjs", import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "soksak-repeat-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, "probe.test.mjs");
  writeFileSync(file, 'import test from "node:test";\ntest("probe passes", () => {});\n');
  // The repeat tool uses the launch start module of the calling repository. The one of this check does nothing.
  writeFileSync(join(dir, "setup.mjs"), "export async function globalSetup() {}\n");
  return file;
}

// The repeat tool runs as a top-level command, so the node:test execution context of this check (NODE_TEST_CONTEXT) is
// not passed on. The color sets only the FORCE_COLOR that the check chooses. When NO_COLOR is also present, node puts a
// warning into the output.
const { NODE_TEST_CONTEXT, NO_COLOR, ...inheritedEnvironment } = process.env;
const environment = {
  ...inheritedEnvironment,
  SOKSAK_WINDOW_CHECK_BASELINE: JSON.stringify({ pid: 100, name: "baseline fixture", bundle: "org.example.baseline" }),
};
const run = (file, name, color = "3") => spawnSync(process.execPath,
  [repeat, "--setup", "./setup.mjs", "--file", file, "--name", name, "--count", "2"],
  { cwd: dirname(file), encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: color } });

test("repeat counts passing runs when the test reporter writes colors", { timeout: 30000 }, (t) => {
  const result = run(fixture(t), "probe passes");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS 2 runs/);
});

for (const color of ["3", "0"]) {
  test(`repeat rejects a name pattern that runs no test with FORCE_COLOR=${color}`, { timeout: 30000 }, (t) => {
    // Even when no check matches the name, node:test reports the file itself as one passed result.
    const result = run(fixture(t), "missing probe", color);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /no test ran for "missing probe"/);
  });
}

test("repeat prints the diagnostics of each passing run", { timeout: 30000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-repeat-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, "probe.test.mjs");
  writeFileSync(file, 'import test from "node:test";\ntest("probe measures", (t) => { t.diagnostic("measured 5ms"); });\n');
  writeFileSync(join(dir, "setup.mjs"), "export async function globalSetup() {}\n");
  const result = run(file, "probe measures");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS run 1 of 2: 1 tests\n {2}measured 5ms\nPASS run 2 of 2: 1 tests\n {2}measured 5ms\n/);
});

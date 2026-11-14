// Checks that the window check repeat tool counts the checks that ran regardless of the output color.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repeat = fileURLToPath(new URL("../repeat.mjs", import.meta.url));

// The tracked folder holds the launch start module, which does nothing, and the checks that the repeat tool runs.
const probes = fileURLToPath(new URL("../fixtures/repeat-probe/", import.meta.url));

// The repeat tool runs as a top-level command, so the node:test execution context of this check (NODE_TEST_CONTEXT) is
// not passed on. The color sets only the FORCE_COLOR that the check chooses. When NO_COLOR is also present, node puts a
// warning into the output.
const { NODE_TEST_CONTEXT, NO_COLOR, ...inheritedEnvironment } = process.env;
const run = (file, name, color = "3") => spawnSync(process.execPath,
  [repeat, "--setup", "./setup.mjs", "--file", file, "--name", name, "--count", "2"],
  { cwd: probes, encoding: "utf8", timeout: 20000, env: { ...inheritedEnvironment, FORCE_COLOR: color } });

test("repeat counts passing runs when the test reporter writes colors", { timeout: 30000 }, () => {
  const result = run(join(probes, "probe-passes.mjs"), "probe passes");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS 2 runs/);
});

for (const color of ["3", "0"]) {
  test(`repeat rejects a name pattern that runs no test with FORCE_COLOR=${color}`, { timeout: 30000 }, () => {
    // Even when no check matches the name, node:test reports the file itself as one passed result.
    const result = run(join(probes, "probe-passes.mjs"), "missing probe", color);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /no test ran for "missing probe"/);
  });
}

test("repeat prints the diagnostics of each passing run", { timeout: 30000 }, () => {
  const result = run(join(probes, "probe-measures.mjs"), "probe measures");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS run 1 of 2: 1 tests\n {2}measured 5ms\nPASS run 2 of 2: 1 tests\n {2}measured 5ms\n/);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The list comes from the real job steps of .github/workflows/ci.yml and the real rules of the Makefile.
function preflightTargets() {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", "check-preflight.mjs"), "--list"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").filter((line) => line.startsWith("target ")).map((line) => line.slice("target ".length));
}

test("the preflight lists the build of the sok executable before the headless owner tests, as the linux-node job orders them", () => {
  const targets = preflightTargets();
  assert.ok(targets.indexOf("build-sok") >= 0, "build-sok is listed");
  assert.ok(targets.indexOf("build-sok") < targets.indexOf("test-headless-owners"), "build-sok runs first");
});

test("the preflight lists the static checks of the host jobs and the equivalence job, and no check that builds an artifact", () => {
  const targets = preflightTargets();
  for (const name of ["check-docs", "check-tests", "check-rust-format", "check-go-format", "check-hosts-same", "check-events"]) {
    assert.ok(targets.includes(name), `${name} is listed`);
  }
  assert.ok(!targets.includes("check-rust-clippy"), "check-rust-clippy is not listed because it needs build-native");
});

test("the preflight passes the revision range to check-commits, as the pre-push range of check-push", () => {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", "check-preflight.mjs"), "--list"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split("\n").find((text) => text.startsWith("target check-commits"));
  assert.equal(line, "target check-commits RANGE=origin/main..HEAD", "check-commits gets the range of check-push");
});

test("the preflight lists the lockfile rejection that every CI job runs through make", () => {
  const targets = preflightTargets();
  assert.ok(targets.includes("check-lockfiles"), "check-lockfiles is listed");
});

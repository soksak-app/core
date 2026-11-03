// Checks that a release build of the Rust workspace loads the proc-macro libraries that it builds for the host. The build
// uses the release profile of the workspace and the deployment target that the Makefile passes to cargo (CARGO_ENV). It
// builds serde with the features that the workspace enables: serde re-exports the derive macros of serde_derive, which
// cargo builds as a dependency through the build override of the release profile, so compiling serde requires rustc to
// load that library.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const minimum = readFileSync(join(root, "Makefile"), "utf8").match(/^MACOS_MINIMUM\s*=\s*(\S+)/m)?.[1];

test("a release build loads the proc-macro libraries that it builds for the host", { timeout: 600000 }, (t) => {
  assert.ok(minimum, "the Makefile declares no MACOS_MINIMUM");
  const target = mkdtempSync(join(tmpdir(), "soksak-rust-release-profile-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const build = spawnSync("cargo", ["build", "--locked", "--release", "-p", "serde", "--message-format=json"], {
    cwd: root, env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: minimum, CARGO_TARGET_DIR: target },
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  assert.ifError(build.error);
  const messages = build.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const errors = messages.filter((message) => message.reason === "compiler-message" && message.message.level === "error")
    .map((message) => message.message.rendered);
  assert.deepEqual(errors, [], "the release build cannot load a proc-macro library that it built");
  assert.equal(build.status, 0, build.stderr);
  const built = messages.filter((message) => message.reason === "compiler-artifact").map((message) => message.target.name);
  assert.ok(built.includes("serde_derive") && built.includes("serde"), `the build did not compile serde with its derive macros: ${built.join(", ")}`);
});

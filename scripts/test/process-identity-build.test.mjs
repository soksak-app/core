// The process identity library builds from a checkout without its build folder, as CI does. The checkout holds the Makefile of the
// repository, which declares the macOS minimum that the package reads when it builds alone. The dry run of make lists the compiler
// and archiver commands in the order of the Makefile on any system; the build with the real clang and ar runs in the system tier on
// macOS (scripts/test/platform/darwin/system/process-identity-build.test.mjs), where the frameworks that the source compiles against exist.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY = fileURLToPath(new URL("../../", import.meta.url));
const PACKAGE = "native/darwin/process-identity";

test("the dry run of make build in a clean checkout lists the compiler and the archiver of the package", { timeout: 60000 }, (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "soksak-process-identity-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  cpSync(join(REPOSITORY, "Makefile"), join(checkout, "Makefile"));
  const root = join(checkout, PACKAGE);
  cpSync(join(REPOSITORY, PACKAGE), root, { recursive: true, filter: (path) => !/\/(build|lib)$/.test(path) });
  const plan = spawnSync("make", ["--dry-run", "build"], { cwd: root, encoding: "utf8" });
  assert.equal(plan.status, 0, `${plan.stdout}\n${plan.stderr}`);
  const commands = plan.stdout.trim().split("\n").filter((line) => /^(?:clang|ar) /.test(line));
  assert.deepEqual(commands.map((line) => line.split(" ")[0]), ["clang", "ar"], plan.stdout);
  assert.match(commands[0], / -c src\/process_identity\.m -o \S+\/native\/darwin\/process-identity\/build\/process_identity\.o$/);
});

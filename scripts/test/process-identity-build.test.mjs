// The process identity library builds from a checkout without its build folder, as CI does. The checkout holds the Makefile of the
// repository, which declares the macOS minimum that the package reads when it builds alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY = fileURLToPath(new URL("../../", import.meta.url));
const PACKAGE = "native/darwin/process-identity";

test("make build creates its build folder in a clean checkout", { timeout: 60000 }, (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "soksak-process-identity-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  cpSync(join(REPOSITORY, "Makefile"), join(checkout, "Makefile"));
  const root = join(checkout, PACKAGE);
  cpSync(join(REPOSITORY, PACKAGE), root, { recursive: true, filter: (path) => !/\/(build|lib)$/.test(path) });
  const result = spawnSync("make", ["build"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(existsSync(join(root, "build", "process_identity.o")));
});

// The process identity library builds from a checkout without its build folder, as CI does.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../../native/darwin/process-identity/", import.meta.url));

test("make build creates its build folder in a clean checkout", { timeout: 60000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "soksak-process-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(SOURCE, root, { recursive: true, filter: (path) => !/\/(build|lib)$/.test(path) });
  const result = spawnSync("make", ["build"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(existsSync(join(root, "build", "process_identity.o")));
});

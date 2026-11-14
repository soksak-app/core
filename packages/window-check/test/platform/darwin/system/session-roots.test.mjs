// The session tests of the harness hold a folder of the file in the temporary folder, which the file removes when it ends, also when
// a selection runs none of its tests (docs/operations/examples.md#temporary-folders). The clipboard file runs the pasteboard of macOS,
// so this test runs only on macOS, and the file it names is in this folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** Runs `file` with a selection that matches none of its tests and a temporary folder of its own, and requires that folder to be empty. */
function leavesNothing(t, file) {
  const temporary = mkdtempSync(join(tmpdir(), "session-roots-"));
  t.after(() => rmSync(temporary, { recursive: true }));
  // NODE_TEST_CONTEXT of this test process would make the file report to this run instead of running as a run of its own.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const result = spawnSync(process.execPath, ["--test", "--test-name-pattern=^no test has this name$", file], {
    cwd: import.meta.dirname, encoding: "utf8", timeout: 60_000, env: { ...env, TMPDIR: `${temporary}/` },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readdirSync(temporary), []);
}

test("session-clipboard.test.mjs removes the folder of the file when a selection runs none of its tests", (t) => {
  leavesNothing(t, "session-clipboard.test.mjs");
});

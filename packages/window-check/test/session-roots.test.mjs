// The session tests of the harness hold a folder of the file in the temporary folder, which the file removes when it ends, also when
// a selection runs none of its tests (docs/operations/examples.md#temporary-folders).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const FILES = ["session-clipboard.test.mjs", "session-frontmost.test.mjs", "session-inactive.test.mjs"];

for (const file of FILES) {
  test(`${file} removes the folder of the file when a selection runs none of its tests`, (t) => {
    const temporary = mkdtempSync(join(tmpdir(), "session-roots-"));
    t.after(() => rmSync(temporary, { recursive: true }));
    // NODE_TEST_CONTEXT of this test process would make the file report to this run instead of running as a run of its own.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const result = spawnSync(process.execPath, ["--test", "--experimental-test-module-mocks", "--test-name-pattern=^no test has this name$", file], {
      cwd: import.meta.dirname, encoding: "utf8", timeout: 60_000, env: { ...env, TMPDIR: `${temporary}/` },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(readdirSync(temporary), []);
  });
}

// The temporary folder of a test process on macOS (scripts/platform/darwin/darwin.mjs, processFolderRoot), which the test runner
// places in /tmp so that the sockets of the host tests fit under the limit of a socket path.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runTests } from "../../../test-runner.mjs";

const REPORT_TEMPORARY = fileURLToPath(new URL("../../fixtures/test-runner-temporary/report-temporary.cjs", import.meta.url));
const node = (name, program, extra = {}) => ({ name, command: process.execPath, args: [program], timeoutMs: 5000, ...extra });

async function run(tests, options = {}) {
  const lines = [];
  const outcome = await runTests({ tests, write: (line) => lines.push(line), heartbeatMs: 50, ...options });
  return { ...outcome, lines };
}

// The host tests place unix sockets in their temporary folder, and the endpoint refuses a socket path over the limit of the rule
// `endpoint.socket.path-over-limit` of docs/spec/host-contract.md. The longest socket path that a host test builds below its
// temporary folder is the endpoint socket of the Rust test folder (tests/support/folder.rs, `h<process>-<n>`) with the longest name
// of a host test, `test-diagnostics-clock`, at the largest process number of macOS and a test folder number of three digits.
const LONGEST_HOST_TEST_SOCKET = "h99999-999/sockets/test-diagnostics-clock-99999.sock";

function socketPathLimit() {
  const spec = readFileSync(new URL("../../../../docs/spec/host-contract.md", import.meta.url), "utf8");
  const row = /`endpoint\.socket\.path-over-limit` \| A socket path longer than (\d+) bytes/.exec(spec);
  assert.ok(row, "docs/spec/host-contract.md has no rule endpoint.socket.path-over-limit with its limit");
  return Number(row[1]);
}

test("the temporary folder of a test process leaves room for the longest socket path of the host tests and is private to the user", async (t) => {
  const out = mkdtempSync(join(tmpdir(), "runner-temporary-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const { results } = await run([node("socket", REPORT_TEMPORARY, { env: { OUT: out } })], { concurrency: 1 });
  assert.equal(results.get("socket").status, "pass", results.get("socket").detail);
  const seen = JSON.parse(readFileSync(join(out, "seen"), "utf8"));
  const limit = socketPathLimit();
  for (const folder of [seen.given, seen.real]) {
    const socket = join(folder, LONGEST_HOST_TEST_SOCKET);
    assert.ok(Buffer.byteLength(socket) <= limit, `${socket} is ${Buffer.byteLength(socket)} bytes, over the limit of ${limit} bytes`);
  }
  assert.equal(seen.mode, 0o700, `the temporary folder of the process has mode ${seen.mode.toString(8)}`);
  assert.equal(seen.uid, process.getuid());
});

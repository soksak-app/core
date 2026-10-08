// A window check writes each step it starts with its elapsed time, so a check that its test time limit ends names the
// step that ran (F118).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const app = new URL("../app.mjs", import.meta.url).href;

// The probe check waits on a status that never changes and ends at its own test time limit. node:test reports the
// test limit, so this check runs the probe in a separate node:test run without its own context (NODE_TEST_CONTEXT).
function run(t) {
  const dir = mkdtempSync(join(tmpdir(), "soksak-session-steps-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, "probe.test.mjs");
  writeFileSync(file, `import test from "node:test";
import { Session } from ${JSON.stringify(app)};
test("probe waits past its limit", { timeout: 300 }, async () => {
  const client = { watch: () => new Promise(() => {}), request: async () => ({ value: 1 }) };
  const session = new Session({ name: "probe" }, client);
  await session.get("core.project");
  await session.until("probe.document", () => false, "the probe document did not start");
});
`);
  const { NODE_TEST_CONTEXT, ...environment } = process.env;
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", file],
    { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: "0" } });
}

test("a check that its test limit ends names the steps it started", { timeout: 30000 }, (t) => {
  const result = run(t);
  const output = result.stdout + result.stderr;
  assert.match(output, /test timed out after 300ms/, output);
  assert.match(output, /step probe \+\d+\.\d s status\.get core\.project/, output);
  assert.match(output, /step probe \+\d+\.\d s until probe\.document/, output);
});

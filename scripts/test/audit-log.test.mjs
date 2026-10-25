// Tests of the command that audits one event log (scripts/audit-log.mjs): its usage and the refusal of a log that does not start
// with log.open. The findings of a log are tested in the log-contract package.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const COMMAND = fileURLToPath(new URL("../audit-log.mjs", import.meta.url));

test("the audit command without its two arguments prints the usage and exits with status 2", () => {
  const result = spawnSync(process.execPath, [COMMAND], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "usage: node scripts/audit-log.mjs <log file> <catalog file>\n");
});

test("the audit command refuses an empty log, since its first line is not log.open", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-audit-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "empty.jsonl");
  const catalog = join(dir, "catalog.json");
  writeFileSync(log, "");
  writeFileSync(catalog, '{"schema":3,"events":{}}');
  const result = spawnSync(process.execPath, [COMMAND, log, catalog], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the first line is not log\.open: the file is empty/);
});

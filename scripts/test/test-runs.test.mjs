import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pruneRuns } from "../test-runs.mjs";

function run(root, id, tests, { finished = true, classified } = {}) {
  const folder = join(root, "target", "test-runs", id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({
    schema: 1, run: id, started_us: 1, finished_us: finished ? 2 : null,
    tests: tests.map(([name, status]) => ({ name, status, started_us: 1, ended_us: 2, elapsed_ms: 1, detail: "", output: `${name}.log` })),
  }));
  if (classified) writeFileSync(join(folder, "classified.json"), JSON.stringify(classified));
  return folder;
}

test("a run that passed is removed, and a run with an unclassified failure or a stop is kept and named", () => {
  const root = mkdtempSync(join(tmpdir(), "runs-"));
  const passed = run(root, "r1", [["a", "pass"]]);
  const failed = run(root, "r2", [["a", "pass"], ["b", "fail"], ["c", "timeout"]]);
  const stopped = run(root, "r3", [["a", "running"]], { finished: false });
  const { removed, kept } = pruneRuns(root);
  assert.deepEqual(removed, ["r1"]);
  assert.deepEqual(kept, [
    { run: "r2", reason: "unclassified failures: b, c" },
    { run: "r3", reason: "unclassified failures: a" },
  ]);
  assert.equal(existsSync(passed), false);
  assert.equal(existsSync(failed), true);
  assert.equal(existsSync(stopped), true);
});

test("a run whose failures are all named by a classification record is removed, and a partial record keeps it", () => {
  const root = mkdtempSync(join(tmpdir(), "runs-"));
  run(root, "r1", [["b", "fail"], ["c", "fail"]], { classified: [{ name: "b", record: "F161.1" }, { name: "c", record: "F161.2" }] });
  run(root, "r2", [["b", "fail"], ["c", "fail"]], { classified: [{ name: "b", record: "F161.1" }] });
  const { removed, kept } = pruneRuns(root);
  assert.deepEqual(removed, ["r1"]);
  assert.deepEqual(kept, [{ run: "r2", reason: "unclassified failures: c" }]);
});

test("a malformed manifest or classification is an error that names the file", () => {
  const root = mkdtempSync(join(tmpdir(), "runs-"));
  const folder = run(root, "r1", [["a", "fail"]]);
  writeFileSync(join(folder, "classified.json"), "{}");
  assert.throws(() => pruneRuns(root), /r1\/classified\.json: expected an array of \{name, record\}/);
  writeFileSync(join(folder, "manifest.json"), "not json");
  assert.throws(() => pruneRuns(root), /r1\/manifest\.json: /);
});

// The Node test files of the workspace run as processes of their own (docs/operations/examples.md#test-runner): the test script of
// each package names its flags and files, and each file becomes one test with its folder and flags.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverNodeTests, parseTestScript } from "../node-tests.mjs";
import { runTests } from "../test-runner.mjs";

const workspace = () => mkdtempSync(join(tmpdir(), "node-tests-"));
const put = (root, path, text) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};

test("a test script is a list of steps: a command before the tests, and the flags and paths of node --test", () => {
  assert.deepEqual(parseTestScript("node --test test/", "p"), { before: [], flags: [], paths: ["test/"] });
  assert.deepEqual(parseTestScript("node --test --experimental-test-module-mocks test/", "p"),
    { before: [], flags: ["--experimental-test-module-mocks"], paths: ["test/"] });
  assert.deepEqual(parseTestScript("pnpm build && node --test test/", "p"), { before: ["pnpm build"], flags: [], paths: ["test/"] });
  assert.deepEqual(parseTestScript("node --test scripts/test/*.test.mjs && pnpm -r test", "p"), { before: [], flags: [], paths: ["scripts/test/*.test.mjs"] });
  assert.throws(() => parseTestScript("jest", "p"), /p: the test script "jest" is not node --test/);
  assert.throws(() => parseTestScript("node --test test/ && echo done", "p"), /p: the test script step "echo done" is not node --test or pnpm/);
});

test("each test file of a package is a test with the folder and the flags of its package", () => {
  const root = workspace();
  put(root, "a/package.json", JSON.stringify({ name: "a", scripts: { test: "node --test --experimental-test-module-mocks test/" } }));
  put(root, "a/test/one.test.mjs", "");
  put(root, "a/test/nested/two.test.mjs", "");
  put(root, "a/test/support/helper.mjs", "");
  put(root, "b/package.json", JSON.stringify({ name: "b", scripts: { test: "pnpm build && node --test test/*.test.mjs" } }));
  put(root, "b/test/three.test.mjs", "");
  put(root, "b/test/skipped.txt", "");
  put(root, "c/package.json", JSON.stringify({ name: "c" }));
  const { tests, before } = discoverNodeTests({ root, packages: ["a", "b", "c"] });
  assert.deepEqual(tests.map((item) => [item.name, item.args.slice(0, -1), item.cwd]), [
    ["a/test/nested/two.test.mjs", ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=tap", "--test-reporter-destination=stderr", "--experimental-test-module-mocks"], join(root, "a")],
    ["a/test/one.test.mjs", ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=tap", "--test-reporter-destination=stderr", "--experimental-test-module-mocks"], join(root, "a")],
    ["a/test/support/helper.mjs", ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=tap", "--test-reporter-destination=stderr", "--experimental-test-module-mocks"], join(root, "a")],
    ["b/test/three.test.mjs", ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=tap", "--test-reporter-destination=stderr"], join(root, "b")],
  ]);
  assert.deepEqual(before, [{ name: "b: pnpm build", command: "pnpm", args: ["build"], cwd: join(root, "b") }]);
});

test("a package whose test script names no file, or whose script cannot be read, is an error that names the package", () => {
  const root = workspace();
  put(root, "a/package.json", JSON.stringify({ name: "a", scripts: { test: "node --test test/" } }));
  mkdirSync(join(root, "a/test"), { recursive: true });
  assert.throws(() => discoverNodeTests({ root, packages: ["a"] }), /a: the test script names no test file in test\//);
  put(root, "b/package.json", JSON.stringify({ name: "b", scripts: { test: "make test" } }));
  assert.throws(() => discoverNodeTests({ root, packages: ["b"] }), /b: the test script "make test" is not node --test/);
});

test("the discovered files run through the runner, each in the folder of its package", async () => {
  const root = workspace();
  put(root, "a/package.json", JSON.stringify({ name: "a", scripts: { test: "node --test test/" } }));
  put(root, "a/test/ok.test.mjs", 'import test from "node:test"; test("ok", () => {});\n');
  put(root, "a/test/bad.test.mjs", 'import test from "node:test"; import assert from "node:assert"; test("bad", () => assert.equal(1, 2));\n');
  const { tests } = discoverNodeTests({ root, packages: ["a"] });
  const lines = [];
  // This test runs under node --test, whose context variable would make the child runs report to this run and exit with 0.
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let results;
  try {
    ({ results } = await runTests({ tests: tests.map((item) => ({ ...item, timeoutMs: 30000 })), concurrency: 2, write: (line) => lines.push(line) }));
  } finally {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
  }
  assert.deepEqual([...results].map(([name, result]) => [name, result.status]).sort(), [["a/test/bad.test.mjs", "fail"], ["a/test/ok.test.mjs", "pass"]]);
  assert.ok(lines.some((line) => /^RUN  a\/test\/ok\.test\.mjs/.test(line)) && lines.some((line) => /^PASS a\/test\/ok\.test\.mjs [0-9.]+s/.test(line)));
});

test("the error of a failed test is kept when its file is killed at its limit before it ends", async () => {
  const root = workspace();
  put(root, "a/package.json", JSON.stringify({ name: "a", scripts: { test: "node --test test/" } }));
  put(root, "a/test/slow.test.mjs", 'import test from "node:test"; import assert from "node:assert";\n'
    + 'test("fails first", () => assert.equal("kept-actual", "kept-expected"));\n'
    + 'test("never ends", () => new Promise(() => setInterval(() => {}, 1000)));\n');
  const { tests } = discoverNodeTests({ root, packages: ["a"] });
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let results;
  try {
    ({ results } = await runTests({ tests: tests.map((item) => ({ ...item, timeoutMs: 3000 })), concurrency: 1, write: () => {} }));
  } finally {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
  }
  const [result] = [...results.values()];
  assert.equal(result.status, "timeout");
  assert.match(result.output, /kept-actual/, `the output of the killed file lacks the error of its failed test:\n${result.output}`);
});

test("the root names its own test files in test:scripts because its test script runs this runner", () => {
  const root = workspace();
  put(root, "package.json", JSON.stringify({ name: "root", scripts: { test: "node scripts/node-tests.mjs", "test:scripts": "node --test scripts/test/*.test.mjs scripts/test/platform/darwin/*.test.mjs" } }));
  put(root, "scripts/test/x.test.mjs", "");
  put(root, "scripts/test/platform/darwin/bundle-preparation.test.mjs", "");
  const { tests } = discoverNodeTests({ root, packages: ["."] });
  assert.deepEqual(tests.map((item) => [item.name, item.cwd]), [
    ["scripts/test/platform/darwin/bundle-preparation.test.mjs", join(root, ".")],
    ["scripts/test/x.test.mjs", join(root, ".")],
  ]);
});

test("another script of the packages that have it is discovered, and quotes around a glob are not part of the path", () => {
  const root = workspace();
  put(root, "e2e/package.json", JSON.stringify({ name: "e2e", scripts: { test: "node --test test/*.test.mjs", verify: "node --test --test-concurrency=1 --test-global-setup=./setup.mjs './*.test.mjs'" } }));
  put(root, "e2e/a.test.mjs", "");
  put(root, "e2e/test/unit.test.mjs", "");
  put(root, "other/package.json", JSON.stringify({ name: "other", scripts: { test: "node --test test/" } }));
  put(root, "other/test/x.test.mjs", "");
  const { tests } = discoverNodeTests({ root, packages: ["e2e", "other"], script: "verify" });
  assert.deepEqual(tests.map((item) => [item.name, item.args.slice(0, -1)]), [["e2e/a.test.mjs", ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=tap", "--test-reporter-destination=stderr", "--test-concurrency=1", "--test-global-setup=./setup.mjs"]]]);
});

test("the idle gate waits until the person gave no input for the given seconds", async () => {
  const { whenIdle } = await import("../node-tests.mjs");
  const readings = [2, 4, 31];
  const lines = [];
  await whenIdle(30, { idle: () => readings.shift(), intervalMs: 1, write: (line) => lines.push(line) })({ name: "e2e/x.test.mjs" });
  assert.deepEqual(readings, []);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^WAIT e2e\/x\.test\.mjs: the person was active 2s ago, waiting for 30s without input$/);
  await assert.rejects(whenIdle(30, { idle: () => null })({ name: "x" }), /the system does not report the idle time of the input/);
});

test("a run is named by its start time and process id and keeps its folder under target/test-runs", async () => {
  const { newRun } = await import("../node-tests.mjs");
  const run = newRun("/repo", new Date("2026-10-11T04:05:06Z"));
  assert.equal(run.id, `20261011T040506-${process.pid}`);
  assert.equal(run.folder, `/repo/target/test-runs/${run.id}`);
});

test("the audit of the logs runs after a run of window checks and of the activation tier, and after no other script", async () => {
  const { auditAfterRun } = await import("../node-tests.mjs");
  const run = { id: "r1", folder: "/repo/target/test-runs/r1" };
  const ran = [];
  const lines = [];
  const audit = (folder) => { ran.push(folder); return ["/c/logs/host-1-2.jsonl:3: undeclared error place: boom"]; };
  assert.equal(auditAfterRun("test", run, (line) => lines.push(line), audit), 0);
  assert.deepEqual(ran, []);
  for (const script of ["verify", "verify:activation"]) {
    assert.equal(auditAfterRun(script, run, (line) => lines.push(line), audit), 1);
  }
  assert.deepEqual(ran, [run.folder, run.folder]);
  assert.deepEqual(lines.slice(0, 2), [
    "AUDIT /c/logs/host-1-2.jsonl:3: undeclared error place: boom",
    "AUDIT FAIL 1 findings in the logs of run r1; the judgment of each test is /repo/target/test-runs/r1/judgment.json",
  ]);
  assert.equal(auditAfterRun("verify", run, (line) => lines.push(line), () => []), 0);
  assert.equal(lines.at(-1), "AUDIT PASS the logs of run r1");
  assert.equal(auditAfterRun("verify", run, (line) => lines.push(line), () => { throw new Error("marks.jsonl: the run left no test marks"); }), 1);
  assert.equal(lines.at(-1), "AUDIT FAIL marks.jsonl: the run left no test marks");
});

// The push gate runs the test files of the packages whose files the push range changes, and no other package.
test("a change under a package selects the test files of that package only", () => {
  const root = workspace();
  put(root, "a/package.json", JSON.stringify({ name: "a", scripts: { test: "node --test test/" } }));
  put(root, "a/test/one.test.mjs", "");
  put(root, "b/package.json", JSON.stringify({ name: "b", scripts: { test: "node --test test/" } }));
  put(root, "b/test/two.test.mjs", "");
  const { tests } = discoverNodeTests({ root, packages: ["a", "b"], changed: ["a/src/index.js"] });
  assert.deepEqual(tests.map((item) => item.name), ["a/test/one.test.mjs"]);
});

test("a change selects the deepest package that holds it, and a change outside every package selects the root", () => {
  const root = workspace();
  put(root, "package.json", JSON.stringify({ name: "root", scripts: { test: "node scripts/node-tests.mjs", "test:scripts": "node --test scripts/test/*.test.mjs scripts/test/platform/darwin/*.test.mjs" } }));
  put(root, "scripts/test/s.test.mjs", "");
  put(root, "a/package.json", JSON.stringify({ name: "a", scripts: { test: "node --test test/" } }));
  put(root, "a/test/one.test.mjs", "");
  put(root, "a/inner/package.json", JSON.stringify({ name: "inner", scripts: { test: "node --test test/" } }));
  put(root, "a/inner/test/two.test.mjs", "");
  const packages = [".", "a", "a/inner"];
  const names = (changed) => discoverNodeTests({ root, packages, changed }).tests.map((item) => item.name);
  assert.deepEqual(names(["a/inner/src/x.js"]), ["a/inner/test/two.test.mjs"]);
  assert.deepEqual(names(["README.md"]), ["scripts/test/s.test.mjs"]);
  assert.deepEqual(names([]), []);
});

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
    ["a/test/nested/two.test.mjs", ["--test", "--experimental-test-module-mocks"], join(root, "a")],
    ["a/test/one.test.mjs", ["--test", "--experimental-test-module-mocks"], join(root, "a")],
    ["a/test/support/helper.mjs", ["--test", "--experimental-test-module-mocks"], join(root, "a")],
    ["b/test/three.test.mjs", ["--test"], join(root, "b")],
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
    ({ results } = await runTests({ tests, concurrency: 2, defaultTimeoutMs: 30000, write: (line) => lines.push(line) }));
  } finally {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
  }
  assert.deepEqual([...results].map(([name, result]) => [name, result.status]).sort(), [["a/test/bad.test.mjs", "fail"], ["a/test/ok.test.mjs", "pass"]]);
  assert.ok(lines.some((line) => /^RUN  a\/test\/ok\.test\.mjs/.test(line)) && lines.some((line) => /^PASS a\/test\/ok\.test\.mjs [0-9.]+s/.test(line)));
});

test("the root names its own test files in test:scripts because its test script runs this runner", () => {
  const root = workspace();
  put(root, "package.json", JSON.stringify({ name: "root", scripts: { test: "node scripts/node-tests.mjs", "test:scripts": "node --test scripts/test/*.test.mjs" } }));
  put(root, "scripts/test/x.test.mjs", "");
  const { tests } = discoverNodeTests({ root, packages: ["."] });
  assert.deepEqual(tests.map((item) => [item.name, item.cwd]), [["scripts/test/x.test.mjs", join(root, ".")]]);
});

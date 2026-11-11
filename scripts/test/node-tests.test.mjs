// The Node test files of the workspace run as processes of their own (docs/operations/examples.md#test-parity): the test script of
// each package names its flags and files, and each file becomes one test with its folder and flags.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { candidateSelection, discoverNodeTests, parseTestScript, planNodeRun, selectNodeTests } from "../node-tests.mjs";
import { MAX_TEST_TIMEOUT_MS, runTests } from "../test-runner.mjs";

// The reporter that a test file writes its events with (scripts/test-event-reporter.mjs).
const EVENT_REPORTER = fileURLToPath(new URL("../test-event-reporter.mjs", import.meta.url));

const workspace = () => mkdtempSync(join(tmpdir(), "node-tests-"));
const put = (root, path, text) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};

test("candidate selection requires every declared case and every candidate host", { timeout: 5000 }, () => {
  const values = { only: "", exclude: [] };
  const tests = [{ args: ["--test", "required.test.mjs"] }];
  assert.deepEqual(candidateSelection(values, tests, {}),
    { only: null, exclude: [], changed: false, namePattern: null, apps: ["mygo", "tauriv2", "wailsv3"] });
  for (const changed of [{ only: "one" }, { exclude: ["required"] }, { changed: "HEAD~1" }]) {
    assert.throws(() => candidateSelection({ ...values, ...changed }, tests, {}), /complete declared script/);
  }
  for (const env of [{ SOKSAK_APP: "wailsv3" }, { NATIVE_TEST_ONLY: "one" }, { NODE_OPTIONS: "--test-name-pattern=one" }]) {
    assert.throws(() => candidateSelection(values, tests, env), /complete declared script/);
  }
  for (const arg of ["--test-name-pattern=one", "--test-skip-pattern=one", "--test-only", "--test-shard=1/2"]) {
    assert.throws(() => candidateSelection(values, [{ args: [arg] }], {}), /complete declared script/);
  }
});

for (const [name, source, flags, expected] of [
  ["discovered Node evidence: skipped case", 'test.skip("required", () => {});', "", "fail"],
  ["discovered Node evidence: todo case", 'test.todo("required");', "", "fail"],
  ["discovered Node evidence: skip beside a passing case", 'test("passes", () => {}); test.skip("required", () => {});', "", "fail"],
  ["discovered Node evidence: todo beside a passing case", 'test("passes", () => {}); test.todo("required");', "", "fail"],
  ["discovered Node evidence: empty module", "", "", "fail"],
  ["discovered Node evidence: exit before registration", "process.exit(0);", "", "fail"],
  ["discovered Node evidence: empty suite", 'describe("empty", () => {});', "", "fail"],
  ["discovered Node evidence: skipped suite beside a passing case", 'test("passes", () => {}); describe.skip("required suite", () => {});', "", "fail"],
  ["discovered Node evidence: no selected case", 'test("other", () => {});', "--test-name-pattern=required", "fail"],
  ["discovered Node evidence: passing subtests", 'describe("suite", () => { test("inner", async t => { await t.test("child", () => {}); }); });', "", "pass"],
  ["discovered Node evidence: selected passing case", 'test("required", () => {}); test("other", () => { throw Error("excluded"); });', "--test-name-pattern=required", "pass"],
  ["discovered Node evidence: case named after its file", 'test(import.meta.filename, () => {});', "", "pass"],
]) {
  test(name, { timeout: 30000 }, async (t) => {
    const root = workspace();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    put(root, "a/package.json", JSON.stringify({ scripts: { test: `node --test ${flags} test/*.test.mjs` } }));
    put(root, "a/test/evidence.test.mjs", `import { describe, test } from "node:test";\n${source}\n`);
    const { tests } = discoverNodeTests({ root, packages: ["a"] });
    // Nested node --test runs must not inherit the parent test context.
    const commands = tests.map((item) => ({ ...item, command: "/usr/bin/env", args: ["-u", "NODE_TEST_CONTEXT", item.command, ...item.args] }));
    const { results } = await runTests({ tests: commands, concurrency: 1, write: () => {}, run: { id: "evidence", folder: join(root, "run") } });
    const result = results.get("a/test/evidence.test.mjs");
    assert.equal(result.status, expected, `${name}: ${result.detail}\n${result.output}`);
    if (expected === "fail") assert.match(result.detail, /test evidence/, "the failure must name the missing or incomplete test evidence");
  });
}

test("a test script is a list of steps: a command before the tests, and the flags and paths of node --test", () => {
  assert.deepEqual(parseTestScript("node --test test/", "p"), { before: [], flags: [], paths: ["test/"] });
  assert.deepEqual(parseTestScript("node --test --experimental-test-module-mocks test/", "p"),
    { before: [], flags: ["--experimental-test-module-mocks"], paths: ["test/"] });
  assert.deepEqual(parseTestScript("node ./run.mjs --test --test-concurrency=1 --test-global-setup=./setup.mjs 'activation/*.test.mjs'", "e2e"),
    { before: [], flags: ["--test-concurrency=1", "--test-global-setup=./setup.mjs"], paths: ["activation/*.test.mjs"] });
  assert.deepEqual(parseTestScript("pnpm build && node --test test/", "p"), { before: [{ name: "pnpm build", command: "pnpm", args: ["build"] }], flags: [], paths: ["test/"] });
  assert.deepEqual(parseTestScript("node --test scripts/test/*.test.mjs && pnpm -r test", "p"), { before: [], flags: [], paths: ["scripts/test/*.test.mjs"] });
  assert.throws(() => parseTestScript("jest", "p"), /p: the test script "jest" is not node --test/);
  assert.throws(() => parseTestScript("node --test test/ && echo done", "p"), /p: the test script step "echo done" is not node --test or pnpm/);
});

test("a word of a test script keeps the spaces of its quoted parts and loses its quotes, and an unclosed quote names the script", () => {
  assert.deepEqual(parseTestScript('node --test --test-name-pattern="a quit with a browser tab" e2e/browser.test.mjs', "p"),
    { before: [], flags: ["--test-name-pattern=a quit with a browser tab"], paths: ["e2e/browser.test.mjs"] });
  assert.deepEqual(parseTestScript("node --test --test-name-pattern='a b' 'dir/*.mjs' \"x y\"'z'", "p"),
    { before: [], flags: ["--test-name-pattern=a b"], paths: ["dir/*.mjs", "x yz"] });
  assert.deepEqual(parseTestScript(`node --test --flag="it's" 'say "hi"'`, "p"), { before: [], flags: ["--flag=it's"], paths: ['say "hi"'] });
  assert.throws(() => parseTestScript('node --test --test-name-pattern="a quit test/', "p"),
    /^Error: p: the test script "node --test --test-name-pattern=\"a quit test\/" has invalid syntax: Expected .* but end of input found/);
  assert.throws(() => parseTestScript("node --test 'test/", "p"), /^Error: p: the test script "node --test 'test\/" has invalid syntax: Expected .* but end of input found/);
});

test("each path of a test script names a file, and a path or a glob that names none is an error that names the path and the package folder", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "a/package.json", JSON.stringify({ name: "a", scripts: { test: 'node --test --test-name-pattern="a quit with a browser tab" test/browser.test.mjs' } }));
  put(root, "a/test/browser.test.mjs", "");
  const { tests } = discoverNodeTests({ root, packages: ["a"] });
  assert.deepEqual(tests.map((item) => [item.name, item.args.slice(-2)]), [["a/test/browser.test.mjs", ["--test-name-pattern=a quit with a browser tab", join(root, "a/test/browser.test.mjs")]]]);
  put(root, "b/package.json", JSON.stringify({ name: "b", scripts: { test: "node --test test/ missing.test.mjs" } }));
  put(root, "b/test/one.test.mjs", "");
  assert.throws(() => discoverNodeTests({ root, packages: ["a", "b"] }), /^Error: b: the test script path missing\.test\.mjs names no file in the package folder b$/);
  put(root, "c/package.json", JSON.stringify({ name: "c", scripts: { test: "node --test test/ 'gone/*.test.mjs'" } }));
  put(root, "c/test/one.test.mjs", "");
  assert.throws(() => discoverNodeTests({ root, packages: ["c"] }), /^Error: c: the test script path gone\/\*\.test\.mjs names no file in the package folder c$/);
  // A package that a changed range does not select is not read, so its script does not stop the run of the packages that it selects.
  assert.deepEqual(discoverNodeTests({ root, packages: ["a", "b", "c"], changed: ["a/src/x.js"] }).tests.map((item) => item.name), ["a/test/browser.test.mjs"]);
});

for (const [name, flag, selected, path] of [
  ["declared Node selection executes only the named case: quoted joined pattern", "'--test-name-pattern=^required case$'", "required case", "test/*.test.mjs"],
  ["declared Node selection executes only the named case: separate pattern containing an operator", "--test-name-pattern '^required case && operator$'", "required case && operator", "test/*.test.mjs"],
  ["declared Node selection executes only the named case: double quoted pattern and path", '--test-name-pattern "^required case\\$"', "required case", '"test folder/*.test.mjs"'],
  ["declared Node selection executes only the named case: escaped pattern and path", "--test-name-pattern=^required\\ case\\$", "required case", "test\\ folder/*.test.mjs"],
]) {
  test(name, { timeout: 30000 }, async (t) => {
    const root = workspace();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const directory = path.includes("folder") ? "test folder" : "test";
    put(root, "a/package.json", JSON.stringify({ scripts: { test: `node ./run.mjs --test ${flag} ${path}` } }));
    put(root, `a/${directory}/selected.test.mjs`, `import test from 'node:test';
import { appendFileSync } from 'node:fs';
test(${JSON.stringify(selected)}, () => appendFileSync('executed.jsonl', JSON.stringify(${JSON.stringify(selected)}) + '\\n'));
test('unselected case', () => { appendFileSync('executed.jsonl', 'unselected\\n'); throw Error('unselected case executed'); });
`);
    const { tests } = discoverNodeTests({ root, packages: ["a"] });
    assert.equal(tests.length, 1);
    const commands = tests.map((item) => ({ ...item, env: { NODE_TEST_CONTEXT: undefined } }));
    const { results } = await runTests({ tests: commands, concurrency: 1, write: () => {}, run: { id: "selection", folder: join(root, "run") } });
    const [result] = results.values();
    assert.equal(result.status, "pass", `${result.detail}\n${result.output}`);
    assert.equal(readFileSync(join(root, "a/executed.jsonl"), "utf8"), `${JSON.stringify(selected)}\n`);
  });
}

test("declared Node selection preserves quoted flags, literal dollars and prebuild arguments", () => {
  const script = "pnpm --filter 'package with spaces' build && node --test --test-name-pattern '^literal $HOME && case$' --test-concurrency 1 'test folder/*.test.mjs'";
  const parsed = parseTestScript(script, "a");
  assert.deepEqual(parsed.flags, ["--test-name-pattern", "^literal $HOME && case$", "--test-concurrency", "1"]);
  assert.deepEqual(parsed.paths, ["test folder/*.test.mjs"]);
  const root = workspace();
  try {
    put(root, "a/package.json", JSON.stringify({ scripts: { test: script } }));
    put(root, "a/test folder/selected.test.mjs", "");
    const { before } = discoverNodeTests({ root, packages: ["a"] });
    assert.equal(before.length, 1);
    assert.equal(before[0].command, "pnpm");
    assert.deepEqual(before[0].args, ["--filter", "package with spaces", "build"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("declared Node selection rejects malformed or unsupported shell syntax", () => {
  for (const script of [
    "node --test '--test-name-pattern=unfinished test/",
    'node --test --test-name-pattern "^literal$" test/',
    'node --test --test-name-pattern="$PATTERN" test/',
    "node --test --test-name-pattern=$(printf selected) test/",
    "node --test '--test-name-pattern=`printf selected`' test/",
    "PATTERN=selected node --test test/",
    "node --test test/ | cat",
    "node --test test/ || pnpm build",
    "node --test test/ > result.txt",
    "node --test test/ &",
    "node --test test/; pnpm build",
    "node --test test/ && pnpm build",
    "pnpm -r test && node --test test/",
    "node --test --test-name-pattern",
    "node --test --test-name-pattern --test-only test/",
  ]) {
    assert.throws(() => parseTestScript(script, "a"), /^Error: a: /, script);
  }
});

test("declared Node selection rejects every missing path even beside a valid file", () => {
  const root = workspace();
  try {
    put(root, "a/test/valid.test.mjs", "");
    for (const missing of ["missing.test.mjs", "missing/*.test.mjs", "empty/"]) {
      mkdirSync(join(root, "a/empty"), { recursive: true });
      put(root, "a/package.json", JSON.stringify({ scripts: { test: `node --test test/valid.test.mjs ${missing}` } }));
      assert.throws(() => discoverNodeTests({ root, packages: ["a"] }), (error) => {
        assert.match(error.message, /^a: the test script path .* names no file in the package folder a$/);
        assert.ok(error.message.includes(missing));
        return true;
      }, missing);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each test file of a package is a test with the folder and the flags of its package", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
    ["a/test/nested/two.test.mjs", ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", `--test-reporter=${EVENT_REPORTER}`, "--test-reporter-destination=stderr", "--test-timeout=120000", "--experimental-test-module-mocks"], join(root, "a")],
    ["a/test/one.test.mjs", ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", `--test-reporter=${EVENT_REPORTER}`, "--test-reporter-destination=stderr", "--test-timeout=120000", "--experimental-test-module-mocks"], join(root, "a")],
    ["a/test/support/helper.mjs", ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", `--test-reporter=${EVENT_REPORTER}`, "--test-reporter-destination=stderr", "--test-timeout=120000", "--experimental-test-module-mocks"], join(root, "a")],
    ["b/test/three.test.mjs", ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", `--test-reporter=${EVENT_REPORTER}`, "--test-reporter-destination=stderr", "--test-timeout=120000"], join(root, "b")],
  ]);
  assert.deepEqual(before, [{ name: "b: pnpm build", command: "pnpm", args: ["build"], cwd: join(root, "b") }]);
});

test("each test file runs with a limit for each of its tests and ends when its tests end, and the file has no limit of its own", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "a/package.json", JSON.stringify({ name: "a", scripts: { test: "node --test test/" } }));
  put(root, "a/test/one.test.mjs", "");
  const { tests } = discoverNodeTests({ root, packages: ["a"], testTimeoutMs: 1500 });
  assert.equal(tests.length, 1);
  assert.ok(tests[0].args.includes("--test-timeout=1500"), `the default limit of each test is missing: ${JSON.stringify(tests[0].args)}`);
  assert.ok(!tests[0].args.includes("--test-force-exit"), `the file process ends by process.exit, which drops the output still queued on a pipe: ${JSON.stringify(tests[0].args)}`);
  assert.equal(tests[0].timeoutMs, undefined, "a test file has a limit of its own");
  assert.equal(tests[0].eventLimitMs, MAX_TEST_TIMEOUT_MS, "the event watchdog of a test file is not the largest limit of a test");
  assert.ok(Number.isInteger(tests[0].exitLimitMs) && tests[0].exitLimitMs < tests[0].eventLimitMs, `the exit limit of a test file after its tests ended is ${tests[0].exitLimitMs}`);
  assert.ok(tests[0].args.includes(`--test-reporter=${EVENT_REPORTER}`), `the test file does not report its events: ${JSON.stringify(tests[0].args)}`);
});

test("only and excluded path scopes partition scripts tests from workspace package tests", () => {
  const all = ["scripts/a.test.mjs", "scripts/nested/b.test.mjs", "packages/a/test/a.test.mjs", "e2e/a.test.mjs"]
    .map((name) => ({ name }));
  const scripts = selectNodeTests(all, { only: "scripts/" });
  const packages = selectNodeTests(all, { exclude: ["scripts/"] });
  assert.deepEqual(scripts.map(({ name }) => name), ["scripts/a.test.mjs", "scripts/nested/b.test.mjs"]);
  assert.deepEqual(packages.map(({ name }) => name), ["packages/a/test/a.test.mjs", "e2e/a.test.mjs"]);
  assert.deepEqual([...scripts, ...packages].map(({ name }) => name).sort(), all.map(({ name }) => name).sort());
  assert.equal(new Set([...scripts, ...packages].map(({ name }) => name)).size, all.length);
});

test("a repeated only selects the files that contain any of its values", () => {
  const all = ["scripts/test/a.test.mjs", "e2e/test/b.test.mjs", "e2e/c.test.mjs", "packages/window-check/test/d.test.mjs", "packages/soksak/test/e.test.mjs"]
    .map((name) => ({ name }));
  const selected = selectNodeTests(all, { only: ["scripts/test/", "e2e/test/", "packages/window-check/test/"] });
  assert.deepEqual(selected.map(({ name }) => name), ["scripts/test/a.test.mjs", "e2e/test/b.test.mjs", "packages/window-check/test/d.test.mjs"]);
  assert.deepEqual(selectNodeTests(all, { only: [] }).map(({ name }) => name), all.map(({ name }) => name));
  assert.throws(() => planNodeRun(all, { only: ["missing/", "absent/"] }), /no test file contains "missing\/" or "absent\/"/);
});

test("an excluded folder removes its files under every folder of the workspace and nothing else", () => {
  const all = ["scripts/test/platform/darwin/system/a.test.mjs", "scripts/test/platform/darwin/b.test.mjs",
    "packages/window-check/test/platform/darwin/system/c.test.mjs", "platform/darwin/system/d.test.mjs",
    "e2e/test/platform/darwin/systems/e.test.mjs"].map((name) => ({ name }));
  assert.deepEqual(selectNodeTests(all, { excludeFolder: ["platform/darwin/system"] }).map(({ name }) => name),
    ["scripts/test/platform/darwin/b.test.mjs", "e2e/test/platform/darwin/systems/e.test.mjs"]);
  for (const path of ["", "/platform", "../platform", "platform/../darwin"]) {
    assert.throws(() => selectNodeTests(all, { excludeFolder: [path] }), /--exclude-folder path must be a nonempty root-relative path/);
  }
});

test("excluded test scopes reject empty, absolute, and traversing paths", () => {
  const tests = [{ name: "scripts/a.test.mjs" }];
  for (const path of ["", "/scripts", "../scripts", "scripts/../packages", "C:\\scripts"]) {
    assert.throws(() => selectNodeTests(tests, { exclude: [path] }), /--exclude path must be a nonempty root-relative path/);
  }
});

test("a package whose test script names no file, or whose script cannot be read, is an error that names the package", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "a/package.json", JSON.stringify({ name: "a", scripts: { test: "node --test test/" } }));
  mkdirSync(join(root, "a/test"), { recursive: true });
  assert.throws(() => discoverNodeTests({ root, packages: ["a"] }), /a: the test script path test\/ names no file in the package folder a/);
  put(root, "b/package.json", JSON.stringify({ name: "b", scripts: { test: "make test" } }));
  assert.throws(() => discoverNodeTests({ root, packages: ["b"] }), /b: the test script "make test" is not node --test/);
});

test("the native process identity package exposes its owning tests through Node discovery", { timeout: 120_000 }, () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const { tests, before } = discoverNodeTests({ root, packages: ["native/darwin/process-identity"] });
  assert.deepEqual(tests.map((item) => item.name), ["native/darwin/process-identity/tests/package.test.mjs"]);
  assert.deepEqual(before, []);
});

test("the discovered files run through the runner, each in the folder of its package", async (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
    // A discovered file has an exit limit, which keeps its samples in the folder of the run.
    ({ results } = await runTests({ tests: tests.map((item) => ({ ...item, timeoutMs: 30000 })), concurrency: 2, write: (line) => lines.push(line), run: { id: "discovered", folder: join(root, "run") } }));
  } finally {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
  }
  assert.deepEqual([...results].map(([name, result]) => [name, result.status]).sort(), [["a/test/bad.test.mjs", "fail"], ["a/test/ok.test.mjs", "pass"]]);
  assert.ok(lines.some((line) => /^RUN  a\/test\/ok\.test\.mjs/.test(line)) && lines.some((line) => /^PASS a\/test\/ok\.test\.mjs [0-9.]+s/.test(line)));
});

test("the error of a failed test is kept when its file is killed at its limit before it ends", async (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "a/package.json", JSON.stringify({ name: "a", scripts: { test: "node --test test/" } }));
  put(root, "a/test/slow.test.mjs", 'import test from "node:test"; import assert from "node:assert";\n'
    + 'test("fails first", () => assert.equal("kept-actual", "kept-expected"));\n'
    + 'test("never ends", () => new Promise(() => setInterval(() => {}, 1000)));\n');
  const { tests } = discoverNodeTests({ root, packages: ["a"] });
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let results;
  try {
    ({ results } = await runTests({ tests: tests.map((item) => ({ ...item, timeoutMs: 3000 })), concurrency: 1, write: () => {}, run: { id: "killed", folder: join(root, "run") } }));
  } finally {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
  }
  const [result] = [...results.values()];
  assert.equal(result.status, "timeout");
  assert.match(result.output, /kept-actual/, `the output of the killed file lacks the error of its failed test:\n${result.output}`);
});

test("the root names its own test files in test:scripts because its test script runs this runner", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "package.json", JSON.stringify({ name: "root", scripts: { test: "node scripts/node-tests.mjs", "test:scripts": "node --test scripts/test/*.test.mjs scripts/test/platform/darwin/*.test.mjs" } }));
  put(root, "scripts/test/x.test.mjs", "");
  put(root, "scripts/test/platform/darwin/bundle-preparation.test.mjs", "");
  const { tests } = discoverNodeTests({ root, packages: ["."] });
  assert.deepEqual(tests.map((item) => [item.name, item.cwd]), [
    ["scripts/test/platform/darwin/bundle-preparation.test.mjs", join(root, ".")],
    ["scripts/test/x.test.mjs", join(root, ".")],
  ]);
});

test("another script of the packages that have it is discovered, and quotes around a glob are not part of the path", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "e2e/package.json", JSON.stringify({ name: "e2e", scripts: { test: "node --test test/*.test.mjs", verify: "node ./run.mjs --test --test-concurrency=1 --test-global-setup=./setup.mjs './*.test.mjs'" } }));
  put(root, "e2e/a.test.mjs", "");
  put(root, "e2e/test/unit.test.mjs", "");
  put(root, "other/package.json", JSON.stringify({ name: "other", scripts: { test: "node --test test/" } }));
  put(root, "other/test/x.test.mjs", "");
  const { tests } = discoverNodeTests({ root, packages: ["e2e", "other"], script: "verify" });
  assert.deepEqual(tests.map((item) => [item.name, item.args.slice(0, -1)]), [["e2e/a.test.mjs", ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", `--test-reporter=${EVENT_REPORTER}`, "--test-reporter-destination=stderr", "--test-timeout=120000", "--test-concurrency=1", "--test-global-setup=./setup.mjs"]]]);
});

test("a changed specification file selects the tests of the packages that declare it in specFiles", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "package.json", JSON.stringify({ name: "root", scripts: { "test:scripts": "node --test scripts/test/" } }));
  put(root, "scripts/test/x.test.mjs", "");
  put(root, "reader/package.json", JSON.stringify({ name: "reader", specFiles: ["docs/spec/events.json"], scripts: { test: "node --test test/" } }));
  put(root, "reader/test/audit.test.mjs", "");
  put(root, "cases/package.json", JSON.stringify({ name: "cases", specFiles: ["docs/spec/cases/log-contract/"], scripts: { test: "node --test test/" } }));
  put(root, "cases/test/replay.test.mjs", "");
  put(root, "other/package.json", JSON.stringify({ name: "other", scripts: { test: "node --test test/" } }));
  put(root, "other/test/y.test.mjs", "");
  const names = (changed) => discoverNodeTests({ root, packages: [".", "cases", "other", "reader"], changed }).tests.map((item) => item.name);
  assert.deepEqual(names(["docs/spec/events.json"]), ["scripts/test/x.test.mjs", "reader/test/audit.test.mjs"]);
  assert.deepEqual(names(["docs/spec/cases/log-contract/replay/inputs.json"]), ["scripts/test/x.test.mjs", "cases/test/replay.test.mjs"]);
  assert.deepEqual(names(["docs/spec/events.ko.md"]), ["scripts/test/x.test.mjs"]);
  put(root, "other/package.json", JSON.stringify({ name: "other", specFiles: ["docs/features.md"], scripts: { test: "node --test test/" } }));
  assert.throws(() => names(["docs/spec/events.json"]),
    /other\/package\.json: specFiles must be a list of paths under docs\/spec\/, found \["docs\/features\.md"\]/);
});

test("a run starts each file without waiting for the person, and the runner has no idle option", { timeout: 20000 }, () => {
  // A window check gives the same result while a person uses the keyboard and the pointer, so no run waits for the person.
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../node-tests.mjs", import.meta.url)), "--when-idle", "5",
    "--script", "no-such-script"], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Unknown option '--when-idle'/);
});

test("a run is named by its start time and process id and keeps its folder under target/test-runs", async () => {
  const { newRun } = await import("../node-tests.mjs");
  const run = newRun("/repo", new Date("2026-10-11T04:05:06Z"));
  assert.equal(run.id, `20261011T040506-${process.pid}`);
  assert.equal(run.folder, `/repo/target/test-runs/${run.id}`);
});

test("the audit of the logs runs after window checks and benchmarks, and not after unit tests", async () => {
  const { auditAfterRun } = await import("../node-tests.mjs");
  const run = { id: "r1", folder: "/repo/target/test-runs/r1" };
  const ran = [];
  const lines = [];
  const audit = (folder) => { ran.push(folder); return ["/c/logs/host-1-2.jsonl:3: undeclared error place: boom"]; };
  assert.equal(auditAfterRun("test", run, (line) => lines.push(line), audit), 0);
  assert.deepEqual(ran, []);
  for (const script of ["test-app", "test-app:activation", "benchmark:view-drag"]) {
    assert.equal(auditAfterRun(script, run, (line) => lines.push(line), audit), 1);
  }
  assert.deepEqual(ran, [run.folder, run.folder, run.folder]);
  assert.deepEqual(lines.slice(0, 2), [
    "AUDIT /c/logs/host-1-2.jsonl:3: undeclared error place: boom",
    "AUDIT FAIL 1 findings in the logs of run r1; the judgment of each test is /repo/target/test-runs/r1/judgment.json",
  ]);
  assert.equal(auditAfterRun("test-app", run, (line) => lines.push(line), () => []), 0);
  assert.equal(lines.at(-1), "AUDIT PASS the logs of run r1");
  assert.equal(auditAfterRun("test-app", run, (line) => lines.push(line), () => { throw new Error("marks.jsonl: the run left no test marks"); }), 1);
  assert.equal(lines.at(-1), "AUDIT FAIL marks.jsonl: the run left no test marks");
});

// --changed runs the test files of the packages whose files the revision range changes, and no other package.
test("a change under a package selects the test files of that package only", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "a/package.json", JSON.stringify({ name: "a", scripts: { test: "node --test test/" } }));
  put(root, "a/test/one.test.mjs", "");
  put(root, "b/package.json", JSON.stringify({ name: "b", scripts: { test: "node --test test/" } }));
  put(root, "b/test/two.test.mjs", "");
  const { tests } = discoverNodeTests({ root, packages: ["a", "b"], changed: ["a/src/index.js"] });
  assert.deepEqual(tests.map((item) => item.name), ["a/test/one.test.mjs"]);
});

test("a change selects the deepest package that holds it, and a change outside every package selects the root", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "package.json", JSON.stringify({ name: "root", scripts: { test: "node scripts/node-tests.mjs", "test:scripts": "node --test scripts/test/*.test.mjs" } }));
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

test("a changed range whose tests the exclusions remove runs no test and says why, and an empty selection without a range is an error", () => {
  const all = [{ name: "scripts/test/a.test.mjs" }, { name: "scripts/test/b.test.mjs" }];
  assert.deepEqual(planNodeRun(all, { range: "origin/main..HEAD", exclude: ["scripts"] }),
    { skip: "SKIP no test file of a package changed in origin/main..HEAD remains after --exclude scripts" });
  assert.deepEqual(planNodeRun([], { range: "origin/main..HEAD" }), { skip: "SKIP no test file of a package changed in origin/main..HEAD" });
  assert.deepEqual(planNodeRun(all, { only: "a.test" }), { tests: [all[0]] });
  assert.throws(() => planNodeRun(all, { only: "missing" }), /no test file contains "missing"/);
});

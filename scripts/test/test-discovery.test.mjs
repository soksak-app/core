import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditStatus, discoverGo, discoverRust } from "../test-discovery.mjs";
import { runTests } from "../test-runner.mjs";

const folder = () => mkdtempSync(join(tmpdir(), "discovery-"));

test("Go discovery preserves the selected CGO0 environment through compilation, binary listing and test execution", async (t) => {
  const root = folder();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "go.mod"), "module selectedenvironment\n\ngo 1.21\n");
  writeFileSync(join(root, "selected_test.go"), [
    '//go:build !cgo', '', 'package selectedenvironment',
    'import ("os"; "testing")',
    'func init() { if os.Getenv("SOKSAK_DISCOVERY_TEST_INPUT") != "selected-profile" { panic("listing lost selected native inputs") } }',
    'func TestSelectedEnvironment(t *testing.T) { if os.Getenv("CGO_ENABLED") != "0" { t.Fatal("execution lost CGO0") } }',
  ].join('\n'));
  writeFileSync(join(root, "wrong_test.go"), '//go:build cgo\n\npackage selectedenvironment\nimport "testing"\nfunc TestWrongProfile(t *testing.T) { t.Fatal("compiled wrong CGO profile") }\n');
  const env = { ...process.env, CGO_ENABLED: '0', GOWORK: 'off', SOKSAK_DISCOVERY_TEST_INPUT: 'selected-profile' };
  const { tests, failures } = await discoverGo({ patterns: ['./...'], cwd: root, env,
    buildDir: join(root, 'bin'), id: 'selected-profile', write() {}, concurrency: 1, timeoutMs: 20000 });
  assert.deepEqual(failures, []);
  assert.deepEqual(tests.map((item) => item.testName), ['TestSelectedEnvironment']);
  assert.equal(tests[0].env.CGO_ENABLED, '0');
  assert.equal(tests[0].env.SOKSAK_DISCOVERY_TEST_INPUT, 'selected-profile');
  const { results } = await runTests({ tests, concurrency: 1, write() {} });
  assert.equal(results.get(tests[0].name).status, 'pass');
});

test("a Go package lists its tests and each test runs in the folder of its package", async (t) => {
  const root = folder();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "go.mod"), "module fixture\n\ngo 1.21\n");
  writeFileSync(join(root, "a_test.go"), [
    "package fixture", "", 'import ("os"; "testing")', "",
    "func TestPasses(t *testing.T) { if _, err := os.Stat(\"a_test.go\"); err != nil { t.Fatal(err) } }",
    'func TestFails(t *testing.T) { t.Fatal("on purpose") }',
    'func TestSkips(t *testing.T) { t.Skip("on purpose") }', "",
  ].join("\n"));
  const lines = [];
  const { tests, failures } = await discoverGo({ patterns: ["./..."], cwd: root, buildDir: join(root, "bin"), id: "go", write: (l) => lines.push(l), concurrency: 2, timeoutMs: 20000 });
  assert.deepEqual(failures, []);
  assert.deepEqual(tests.map((item) => item.testName).sort(), ["TestFails", "TestPasses", "TestSkips"]);
  assert.ok(lines.some((line) => /^PASS build go fixture /.test(line)), `no build line: ${JSON.stringify(lines)}`);
  const { results } = await runTests({ tests, concurrency: 2, write() {} });
  assert.deepEqual(tests.map((item) => [item.testName, auditStatus(results.get(item.name))]).sort(), [["TestFails", "fail"], ["TestPasses", "pass"], ["TestSkips", "skip"]]);
});

test("a discovered Go test has the deadline of its limit", async (t) => {
  const root = folder();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "go.mod"), "module deadline\n\ngo 1.21\n");
  writeFileSync(join(root, "a_test.go"), [
    "package deadline", "", 'import ("testing"; "time")', "",
    "func TestDeadline(t *testing.T) {",
    "\tdeadline, ok := t.Deadline()",
    '\tif !ok { t.Fatal("the test has no deadline") }',
    '\tif left := time.Until(deadline); left > 20*time.Second || left < 15*time.Second { t.Fatalf("the deadline is %s away, not the limit of 20s", left) }',
    "}", "",
  ].join("\n"));
  const { tests, failures } = await discoverGo({ patterns: ["./..."], cwd: root, buildDir: join(root, "bin"), id: "go", write() {}, concurrency: 1, timeoutMs: 20000 });
  assert.deepEqual(failures, []);
  const { results } = await runTests({ tests, concurrency: 1, write() {} });
  const result = results.get(tests[0].name);
  assert.equal(result.status, "pass", result.output);
});

test("a Go test over its limit prints the stacks of its goroutines before its group is ended", async (t) => {
  const root = folder();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "go.mod"), "module hangs\n\ngo 1.21\n");
  writeFileSync(join(root, "a_test.go"), [
    "package hangs", "", 'import ("testing"; "time")', "",
    "func waitInTheFixture() { time.Sleep(time.Hour) }", "",
    "func TestHangs(t *testing.T) { waitInTheFixture() }", "",
  ].join("\n"));
  const { tests, failures } = await discoverGo({ patterns: ["./..."], cwd: root, buildDir: join(root, "bin"), id: "go", write() {}, concurrency: 1, timeoutMs: 2000 });
  assert.deepEqual(failures, []);
  const { results } = await runTests({ tests, concurrency: 1, write() {} });
  const result = results.get(tests[0].name);
  assert.equal(result.status, "timeout", result.detail);
  assert.match(result.output, /^goroutine \d+ .*\[sleep\]:$/m, result.output);
  assert.match(result.output, /hangs\.waitInTheFixture\(/, result.output);
});

test("a Go package that does not build is a failure that names the package", async (t) => {
  const root = folder();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "go.mod"), "module broken\n\ngo 1.21\n");
  writeFileSync(join(root, "a_test.go"), "package broken\n\nfunc TestX( {\n");
  const { tests, failures } = await discoverGo({ patterns: ["./..."], cwd: root, buildDir: join(root, "bin"), id: "go", write() {}, concurrency: 1, timeoutMs: 20000 });
  assert.deepEqual(tests, []);
  assert.deepEqual(failures, ["go: the build of broken failed"]);
});

test("a Rust package lists its tests, each test runs by itself, and an ignored test is a skip", async (t) => {
  const root = folder();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.0.1"\nedition = "2021"\n\n[workspace]\n');
  writeFileSync(join(root, "Cargo.lock"), 'version = 4\n\n[[package]]\nname = "fixture"\nversion = "0.0.1"\n');
  writeFileSync(join(root, "src", "lib.rs"), "pub fn one() -> u32 { 1 }\n");
  writeFileSync(join(root, "tests", "a.rs"), [
    "#[test] fn passes() { assert!(std::path::Path::new(\"Cargo.toml\").exists()); }",
    '#[test] fn fails() { panic!("on purpose"); }',
    "#[test] #[ignore] fn skipped() {}", "",
  ].join("\n"));
  const env = { CARGO_TARGET_DIR: join(root, "target"), CARGO_INCREMENTAL: "0" };
  const lines = [];
  const { tests, failures } = await discoverRust({ packageName: "fixture", cwd: root, env, id: "rs", write: (l) => lines.push(l), timeoutMs: 20000 });
  assert.deepEqual(failures, []);
  assert.deepEqual(tests.map((item) => item.testName).sort(), ["fails", "passes", "skipped"]);
  assert.ok(lines.some((line) => /^RUN  build rs /.test(line)), `no build start line: ${JSON.stringify(lines)}`);
  assert.ok(lines.some((line) => /^PASS build rs \d+\.\d{3}s$/.test(line)));
  const { results } = await runTests({ tests, concurrency: 3, write() {} });
  assert.deepEqual(tests.map((item) => [item.testName, auditStatus(results.get(item.name))]).sort(),
    [["fails", "fail"], ["passes", "pass"], ["skipped", "skip"]]);
});

const fixtureRust = join(import.meta.dirname, "fixtures", "repeat-rust");

test("Rust host discovery requires the existing locked dependency graph", { timeout: 240_000 }, async (t) => {
  const target = folder();
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const unlocked = join(import.meta.dirname, "fixtures", "repeat-rust", "unlocked");
  const { tests, failures } = await discoverRust({ packageName: "unlocked", cwd: unlocked, env: { CARGO_TARGET_DIR: target }, id: "locked", write() {}, timeoutMs: 1000 });
  assert.deepEqual(tests, []);
  assert.deepEqual(failures, ["locked: the build failed"]);
  assert.equal(existsSync(join(unlocked, "Cargo.lock")), false, "--locked wrote a lock file");
});

test("a Rust discovery that only lists removes the executables of each run from the target folder", { timeout: 240_000 }, async (t) => {
  const target = folder();
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const lines = [];
  const runs = [];
  for (let run = 0; run < 2; run += 1) {
    runs.push(await discoverRust({ packageName: "fixture", cwd: fixtureRust, env: { CARGO_TARGET_DIR: target }, id: "fixture", write: (line) => lines.push(line), timeoutMs: 20000, listOnly: true }));
  }
  assert.deepEqual(runs.map((run) => run.failures), [[], []], lines.join("\n"));
  for (const run of runs) {
    assert.deepEqual(run.tests.map((item) => item.testName).sort(), ["fixture::alpha", "fixture::beta", "fixture::deployment_target", "fixture::integration_case", "fixture::library_case"]);
  }
  // Each run removed its test executables; the libraries that the builds produced stay in the folder.
  const deps = readdirSync(join(target, "debug", "deps"));
  assert.deepEqual(deps.filter((name) => /^[a-z]+-[0-9a-f]{16}$/.test(name)), []);
  assert.ok(deps.some((name) => /^libfixture-[0-9a-f]{16}\.rlib$/.test(name)), JSON.stringify(deps));
});

test("a Rust discovery that only lists fails and removes nothing when an executable is outside the target folder", { timeout: 240_000 }, async (t) => {
  const target = folder();
  const reported = folder();
  t.after(() => { rmSync(target, { recursive: true, force: true }); rmSync(reported, { recursive: true, force: true }); });
  // The injection point makes cargo metadata report a folder that is not the target folder of the build.
  const { tests, failures } = await discoverRust({ packageName: "fixture", cwd: fixtureRust, env: { CARGO_TARGET_DIR: target, SOKSAK_FAULT_TARGET_DIRECTORY: reported }, id: "outside", write() {}, timeoutMs: 1000, listOnly: true });
  assert.deepEqual(tests, []);
  assert.ok(failures.length > 0, "no failure for the executables outside the target folder");
  for (const failure of failures) assert.match(failure, new RegExp(`^outside: the executable .* is not in the target folder ${reported}$`), failure);
  // Nothing was removed: the executables of the build stay in the folder of the build.
  const deps = readdirSync(join(target, "debug", "deps"));
  assert.ok(deps.some((name) => /^fixture-[0-9a-f]{16}$/.test(name)), JSON.stringify(deps));
});

test("a cargo line that starts with a brace but is not JSON fails with the line", async () => {
  const { cargoTestExecutables } = await import("../test-discovery.mjs");
  const artifact = JSON.stringify({ reason: "compiler-artifact", profile: { test: true }, executable: "/t/a", manifest_path: "/p/Cargo.toml", target: { name: "a", src_path: "/p/tests/a.rs" } });
  assert.deepEqual(cargoTestExecutables(artifact), [{ executable: "/t/a", dir: "/p", target: "a", srcPath: "/p/tests/a.rs" }]);
  const missingTargetSource = JSON.stringify({ reason: "compiler-artifact", profile: { test: true }, executable: "/t/a", manifest_path: "/p/Cargo.toml", target: { name: "a" } });
  assert.throws(() => cargoTestExecutables(missingTargetSource), /missing or has invalid manifest path, target name or source path/);
  assert.throws(() => cargoTestExecutables(`${artifact}\n{not json\n`), (error) => error.message.includes("{not json"));
});

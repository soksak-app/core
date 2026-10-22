import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditStatus, discoverGo, discoverRust } from "../test-discovery.mjs";
import { runTests } from "../test-runner.mjs";

const folder = () => mkdtempSync(join(tmpdir(), "discovery-"));

test("a Go package lists its tests and each test runs in the folder of its package", async () => {
  const root = folder();
  writeFileSync(join(root, "go.mod"), "module fixture\n\ngo 1.21\n");
  writeFileSync(join(root, "a_test.go"), [
    "package fixture", "", 'import ("os"; "testing")', "",
    "func TestPasses(t *testing.T) { if _, err := os.Stat(\"a_test.go\"); err != nil { t.Fatal(err) } }",
    'func TestFails(t *testing.T) { t.Fatal("on purpose") }',
    'func TestSkips(t *testing.T) { t.Skip("on purpose") }', "",
  ].join("\n"));
  const lines = [];
  const { tests, failures } = await discoverGo({ patterns: ["./..."], cwd: root, buildDir: join(root, "bin"), id: "go", write: (l) => lines.push(l), concurrency: 2 });
  assert.deepEqual(failures, []);
  assert.deepEqual(tests.map((item) => item.testName).sort(), ["TestFails", "TestPasses", "TestSkips"]);
  assert.ok(lines.some((line) => /^PASS build go fixture /.test(line)), `no build line: ${JSON.stringify(lines)}`);
  const { results } = await runTests({ tests, concurrency: 2, defaultTimeoutMs: 20000, write() {} });
  assert.deepEqual(tests.map((item) => [item.testName, auditStatus(results.get(item.name))]).sort(), [["TestFails", "fail"], ["TestPasses", "pass"], ["TestSkips", "skip"]]);
});

test("a Go package that does not build is a failure that names the package", async () => {
  const root = folder();
  writeFileSync(join(root, "go.mod"), "module broken\n\ngo 1.21\n");
  writeFileSync(join(root, "a_test.go"), "package broken\n\nfunc TestX( {\n");
  const { tests, failures } = await discoverGo({ patterns: ["./..."], cwd: root, buildDir: join(root, "bin"), id: "go", write() {}, concurrency: 1 });
  assert.deepEqual(tests, []);
  assert.deepEqual(failures, ["go: the build of broken failed"]);
});

test("a Rust package lists its tests, each test runs by itself, and an ignored test is a skip", async () => {
  const root = folder();
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.0.1"\nedition = "2021"\n\n[workspace]\n');
  writeFileSync(join(root, "src", "lib.rs"), "pub fn one() -> u32 { 1 }\n");
  writeFileSync(join(root, "tests", "a.rs"), [
    "#[test] fn passes() { assert!(std::path::Path::new(\"Cargo.toml\").exists()); }",
    '#[test] fn fails() { panic!("on purpose"); }',
    "#[test] #[ignore] fn skipped() {}", "",
  ].join("\n"));
  const env = { CARGO_TARGET_DIR: join(root, "target"), CARGO_INCREMENTAL: "0" };
  const lines = [];
  const { tests, failures } = await discoverRust({ packageName: "fixture", cwd: root, env, id: "rs", write: (l) => lines.push(l) });
  assert.deepEqual(failures, []);
  assert.deepEqual(tests.map((item) => item.testName).sort(), ["fails", "passes", "skipped"]);
  assert.ok(lines.some((line) => /^PASS build rs \d+\.\d{3}s$/.test(line)));
  const { results } = await runTests({ tests, concurrency: 3, defaultTimeoutMs: 20000, write() {} });
  assert.deepEqual(tests.map((item) => [item.testName, auditStatus(results.get(item.name))]).sort(),
    [["fails", "fail"], ["passes", "pass"], ["skipped", "skip"]]);
});

test("a cargo line that starts with a brace but is not JSON fails with the line", async () => {
  const { cargoTestExecutables } = await import("../test-discovery.mjs");
  const artifact = JSON.stringify({ reason: "compiler-artifact", profile: { test: true }, executable: "/t/a", manifest_path: "/p/Cargo.toml", target: { name: "a" } });
  assert.deepEqual(cargoTestExecutables(artifact), [{ executable: "/t/a", dir: "/p", target: "a" }]);
  assert.throws(() => cargoTestExecutables(`${artifact}\n{not json\n`), (error) => error.message.includes("{not json"));
});

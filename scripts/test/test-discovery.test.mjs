import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  const { tests, failures } = await discoverGo({ patterns: ["./..."], cwd: root, buildDir: join(root, "bin"), id: "go", write: (l) => lines.push(l), concurrency: 2, timeoutMs: 20000 });
  assert.deepEqual(failures, []);
  assert.deepEqual(tests.map((item) => item.testName).sort(), ["TestFails", "TestPasses", "TestSkips"]);
  assert.ok(lines.some((line) => /^PASS build go fixture /.test(line)), `no build line: ${JSON.stringify(lines)}`);
  const { results } = await runTests({ tests, concurrency: 2, write() {} });
  assert.deepEqual(tests.map((item) => [item.testName, auditStatus(results.get(item.name))]).sort(), [["TestFails", "fail"], ["TestPasses", "pass"], ["TestSkips", "skip"]]);
});

test("a discovered Go test has the deadline of its limit", async () => {
  const root = folder();
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

test("a Go test over its limit prints the stacks of its goroutines before its group is ended", async () => {
  const root = folder();
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

test("a Go package that does not build is a failure that names the package", async () => {
  const root = folder();
  writeFileSync(join(root, "go.mod"), "module broken\n\ngo 1.21\n");
  writeFileSync(join(root, "a_test.go"), "package broken\n\nfunc TestX( {\n");
  const { tests, failures } = await discoverGo({ patterns: ["./..."], cwd: root, buildDir: join(root, "bin"), id: "go", write() {}, concurrency: 1, timeoutMs: 20000 });
  assert.deepEqual(tests, []);
  assert.deepEqual(failures, ["go: the build of broken failed"]);
});

test("a Rust package lists its tests, each test runs by itself, and an ignored test is a skip", async () => {
  const root = folder();
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

test("Rust host discovery requires the existing locked dependency graph", { timeout: 10_000 }, async (t) => {
  const root = folder();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.0.1"\nedition = "2021"\n\n[workspace]\n');
  writeFileSync(join(root, "src", "lib.rs"), "pub fn one() -> u32 { 1 }\n");
  const binary = join(root, "fixture-test");
  writeFileSync(binary, '#!/bin/sh\nprintf "fixture::locked: test\\n\\n1 tests, 0 benchmarks\\n"\n');
  chmodSync(binary, 0o755);
  const cargo = join(root, "cargo");
  writeFileSync(cargo, `#!/bin/sh
case "$1" in
  test) case " $* " in *" --locked "*) ;; *) echo "Rust discovery omitted --locked" >&2; exit 1 ;; esac
    printf '%s\\n' '{"reason":"compiler-artifact","profile":{"test":true},"manifest_path":"${join(root, "Cargo.toml")}","target":{"name":"fixture","src_path":"${join(root, "src/lib.rs")}"},"executable":"${binary}"}' ;;
  *) echo "unexpected cargo command: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(cargo, 0o755);
  const oldPath = process.env.PATH;
  const lines = [];
  process.env.PATH = `${root}:${oldPath}`;
  try {
    const { tests, failures } = await discoverRust({ packageName: "fixture", cwd: root, id: "locked", write: (line) => lines.push(line), timeoutMs: 1000 });
    assert.deepEqual(failures, [], lines.join("\n"));
    assert.deepEqual(tests.map((item) => item.testName), ["fixture::locked"]);
  } finally {
    process.env.PATH = oldPath;
  }
});

/**
 * A folder with a fake `cargo` whose `test` builds the executable `deps/<id>` of the target folder `target` (or `elsewhere`
 * for the id `outside`) from `built/<id>` and records, before each build, which executables of earlier builds are still on
 * the disk.
 */
function listOnlyFixture() {
  const root = folder();
  const target = join(root, "target");
  mkdirSync(join(target, "deps"), { recursive: true });
  mkdirSync(join(root, "elsewhere"));
  mkdirSync(join(root, "built"));
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.0.1"\nedition = "2021"\n\n[workspace]\n');
  writeFileSync(join(target, "deps", "libdependency-9f.rlib"), "");
  for (const id of ["first", "second", "outside"]) {
    const binary = join(root, "built", id);
    writeFileSync(binary, `#!/bin/sh\nprintf "fixture::${id}: test\\n\\n1 tests, 0 benchmarks\\n"\n`);
    chmodSync(binary, 0o755);
  }
  const cargo = join(root, "cargo");
  writeFileSync(cargo, `#!/bin/sh
case "$1" in
  metadata) printf '%s\\n' '{"target_directory":"${target}"}' ;;
  test) id=$(printf '%s' "$*" | sed 's/.*-p \\([a-z]*\\).*/\\1/')
    for earlier in first second; do [ -e "${target}/deps/$earlier" ] && echo "$id sees $earlier" >> "${root}/seen"; done
    dir=${target}/deps; [ "$id" = outside ] && dir=${root}/elsewhere
    cp "${root}/built/$id" "$dir/$id"
    printf '%s\\n' "{\\"reason\\":\\"compiler-artifact\\",\\"profile\\":{\\"test\\":true},\\"manifest_path\\":\\"${join(root, "Cargo.toml")}\\",\\"target\\":{\\"name\\":\\"fixture\\",\\"src_path\\":\\"${join(root, "src/lib.rs")}\\"},\\"executable\\":\\"$dir/$id\\"}" ;;
  *) echo "unexpected cargo command: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(cargo, 0o755);
  return { root, target };
}

/** Runs `body` with the fake cargo of `root` first on the path. */
async function withCargoOf(root, body) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${root}:${oldPath}`;
  try {
    return await body();
  } finally {
    process.env.PATH = oldPath;
  }
}

test("a Rust discovery that only lists removes the executable of a run before the next run builds", { timeout: 10_000 }, async (t) => {
  const { root, target } = listOnlyFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lines = [];
  const listed = await withCargoOf(root, async () => {
    const runs = [];
    for (const id of ["first", "second"]) {
      runs.push(await discoverRust({ packageName: id, cwd: root, id, write: (line) => lines.push(line), timeoutMs: 1000, listOnly: true }));
    }
    return runs;
  });
  assert.deepEqual(listed.map((run) => run.failures), [[], []], lines.join("\n"));
  assert.deepEqual(listed.map((run) => run.tests.map((item) => item.testName)), [["fixture::first"], ["fixture::second"]]);
  // The build of the second run saw no executable of the first; the libraries of the dependencies stay.
  assert.equal(existsSync(join(root, "seen")) ? readFileSync(join(root, "seen"), "utf8") : "", "");
  assert.deepEqual(readdirSync(join(target, "deps")), ["libdependency-9f.rlib"]);
});

test("a Rust discovery that only lists fails and removes nothing when an executable is outside the target folder", { timeout: 10_000 }, async (t) => {
  const { root } = listOnlyFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { tests, failures } = await withCargoOf(root, () => discoverRust({ packageName: "outside", cwd: root, id: "outside", write() {}, timeoutMs: 1000, listOnly: true }));
  assert.deepEqual(tests, []);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^outside: the executable .*elsewhere\/outside is not in the target folder .*target$/);
  assert.ok(existsSync(join(root, "elsewhere", "outside")));
});

test("a cargo line that starts with a brace but is not JSON fails with the line", async () => {
  const { cargoTestExecutables } = await import("../test-discovery.mjs");
  const artifact = JSON.stringify({ reason: "compiler-artifact", profile: { test: true }, executable: "/t/a", manifest_path: "/p/Cargo.toml", target: { name: "a", src_path: "/p/tests/a.rs" } });
  assert.deepEqual(cargoTestExecutables(artifact), [{ executable: "/t/a", dir: "/p", target: "a", srcPath: "/p/tests/a.rs" }]);
  const missingTargetSource = JSON.stringify({ reason: "compiler-artifact", profile: { test: true }, executable: "/t/a", manifest_path: "/p/Cargo.toml", target: { name: "a" } });
  assert.throws(() => cargoTestExecutables(missingTargetSource), /missing or has invalid manifest path, target name or source path/);
  assert.throws(() => cargoTestExecutables(`${artifact}\n{not json\n`), (error) => error.message.includes("{not json"));
});

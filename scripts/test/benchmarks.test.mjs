// Verifies that `make benchmark-go` and `make benchmark-rust` give each benchmark its own limit and name it when it starts and reports
// its result and elapsed time, while the benchmark output is kept. The packages are the tracked fixtures under
// scripts/test/fixtures/benchmarks, built and run by the real go and cargo toolchains: the Go fixture module holds the benchmark
// package `bench` and the cgo package `linked`, which the external linker reports for a newer macOS version than the link, and the
// Rust fixture is a workspace of its own with the bench targets of the runner. Each make target takes its fixture package through
// BENCH_GO_PACKAGE and BENCH_RUST_PACKAGE, and the Rust manifest through MANIFEST. The limit is the parameter BENCH_TIMEOUT of the
// run: the first target ends at once, and the second target runs for 30 seconds, longer than the limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const fixtures = join(root, 'scripts/test/fixtures/benchmarks');
const goModule = join(fixtures, 'go');
const goBench = `./${relative(root, join(goModule, 'bench'))}`;
const goLinked = `./${relative(root, join(goModule, 'linked'))}`;
const rustManifest = join(fixtures, 'rust', 'Cargo.toml');

/** A folder holding a go.work that uses the Go fixture module, and the path of that go.work. */
function workspaceFor(t) {
  const directory = mkdtempSync(join(tmpdir(), 'soksak-benchmarks-go-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'go.work');
  writeFileSync(file, `go 1.27.3\n\nuse ${relative(directory, goModule)}\n`);
  return file;
}

/** An empty folder for the Cargo target directory of one run, so that the fixture folder gets no build output. */
function targetFolderFor(t) {
  const directory = mkdtempSync(join(tmpdir(), 'soksak-benchmarks-cargo-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Runs `make` with the arguments in the repository root, with the Go fixture module selected through a go.work of its own. */
function make(t, args, env = {}) {
  return spawnSync('make', args, {
    cwd: root, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, GOWORK: workspaceFor(t), BENCH_TIMEOUT: '20', ...env },
  });
}

test('make benchmark-go names each benchmark when it starts, keeps its output, and kills a benchmark at its limit', { timeout: 150000 }, (t) => {
  const result = make(t, ['benchmark-go', `BENCH_GO_PACKAGE=${goBench}`]);
  assert.match(result.stdout, /^RUN  BenchmarkEventLogEmit \(1 running, limit 20\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS BenchmarkEventLogEmit \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^BenchmarkEventLogEmit(?:-\d+)?\s+1\s+\d+(?:\.\d+)? ns\/op$/m, 'the measurement of the benchmark is not shown');
  assert.match(result.stdout, /^RUN  BenchmarkNativePull \(1 running, limit 20\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^TIME BenchmarkNativePull \d+\.\d{3}s exceeded 20\.000s and was killed(?:; left running: .*)?$/m, result.stdout + result.stderr);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
});

test('make benchmark-go fails a benchmark build whose link reports an object newer than the link, and names the object and both versions', { timeout: 150000 }, (t) => {
  const result = make(t, ['benchmark-go', `BENCH_GO_PACKAGE=${goLinked}`]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /ld built \S+ for macOS 27\.0, newer than the macOS 14\.4 of the link/, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /^RUN  Benchmark/m, 'a benchmark of a build with a linker failure ran');
});

test('make benchmark-rust names each bench target when it starts, and kills a target at its limit', { timeout: 150000 }, (t) => {
  const result = make(t, ['benchmark-rust', 'BENCH_RUST_PACKAGE=benchmark-fixture', `MANIFEST=${rustManifest}`], { CARGO_TARGET_DIR: targetFolderFor(t) });
  assert.match(result.stdout, /^RUN  event_log_benchmark \(1 running, limit 20\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS event_log_benchmark \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^event log mean \d+ ns$/m, 'the measurement of the bench target is not shown');
  assert.match(result.stdout, /^RUN  event_native_benchmark \(1 running, limit 20\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^TIME event_native_benchmark \d+\.\d{3}s exceeded 20\.000s and was killed(?:; left running: .*)?$/m, result.stdout + result.stderr);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
});

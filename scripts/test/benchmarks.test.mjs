// Verifies that `make benchmark-go` and `make benchmark-rust` give each benchmark its own limit and name it when it starts and reports
// its result and elapsed time, while the benchmark output is kept. The Go and Cargo toolchains are replaced by fakes on PATH. The fake
// `go test -c -o <file>` writes a test binary that lists two benchmarks and runs the one named by `-test.bench`; the fake `cargo bench`
// runs the second bench target for longer than its limit. The benchmark of the first target prints its measurement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');

function toolchain(t) {
  const directory = mkdtempSync(join(tmpdir(), 'soksak-benchmarks-'));
  t.after(() => rmSync(directory, { recursive: true }));
  writeFileSync(join(directory, 'go'), `#!/bin/sh
case "$1" in
  list) echo ${JSON.stringify(directory)}; exit 0 ;;
  test) out=""; while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done
    if [ -z "$out" ]; then printf 'BenchmarkEventLogEmit-10  1  120 ns/op\nPASS\n'; exit 0; fi
    cat > "$out" <<'BINARY'
#!/bin/sh
case "$1" in -test.list*) printf 'TestAlpha\\nBenchmarkEventLogEmit\\nBenchmarkNativePull\\n'; exit 0 ;; esac
case "$*" in *NativePull*) sleep 8 ;; esac
printf 'BenchmarkEventLogEmit-10  1  120 ns/op\\n'
printf 'PASS\\n'
BINARY
    chmod +x "$out"; exit 0 ;;
esac
exit 1
`);
  writeFileSync(join(directory, 'cargo'), `#!/bin/sh
case "$*" in
  *event_native_benchmark*) sleep 8 ;;
  *) echo "event log mean 120 ns" ;;
esac
exit 0
`);
  chmodSync(join(directory, 'go'), 0o755);
  chmodSync(join(directory, 'cargo'), 0o755);
  return directory;
}

function make(directory, target) {
  return spawnSync('make', target, {
    cwd: root, encoding: 'utf8', timeout: 90000,
    env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}`, BENCH_TIMEOUT: '2' },
  });
}

test('make benchmark-go names each benchmark when it starts, keeps its output, and kills a benchmark at its limit', (t) => {
  const directory = toolchain(t);
  const result = make(directory, ['benchmark-go']);
  assert.match(result.stdout, /^RUN  BenchmarkEventLogEmit \(1 running, limit 2\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS BenchmarkEventLogEmit \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^BenchmarkEventLogEmit-10 {2}1 {2}120 ns\/op$/m, 'the measurement of the benchmark is not shown');
  assert.match(result.stdout, /^RUN  BenchmarkNativePull \(1 running, limit 2\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^TIME BenchmarkNativePull \d+\.\d{3}s exceeded 2\.000s and was killed$/m, result.stdout + result.stderr);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
});

test('make benchmark-rust names each bench target when it starts, and kills a target at its limit', (t) => {
  const directory = toolchain(t);
  const result = make(directory, ['benchmark-rust']);
  assert.match(result.stdout, /^RUN  event_log_benchmark \(1 running, limit 2\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS event_log_benchmark \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^event log mean 120 ns$/m, 'the measurement of the bench target is not shown');
  assert.match(result.stdout, /^RUN  event_native_benchmark \(1 running, limit 2\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^TIME event_native_benchmark \d+\.\d{3}s exceeded 2\.000s and was killed$/m, result.stdout + result.stderr);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
});

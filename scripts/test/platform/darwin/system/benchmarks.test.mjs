// Verifies that `make benchmark-go` fails a benchmark build whose link reports an object built for a newer macOS version than the link.
// The case is the cgo package `linked` of the Go fixture module, which the macOS linker checks against the native library of the package,
// so the test needs the macOS linker and the native library that `make` builds on macOS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../../../../..');
const goModule = join(root, 'scripts/test/fixtures/benchmarks/go');
const goLinked = `./${relative(root, join(goModule, 'linked'))}`;

/** A folder holding a go.work that uses the Go fixture module, and the path of that go.work. */
function workspaceFor(t) {
  const directory = mkdtempSync(join(tmpdir(), 'soksak-benchmarks-go-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'go.work');
  writeFileSync(file, `go 1.27.3\n\nuse ${relative(directory, goModule)}\n`);
  return file;
}

/** Runs `make` with the arguments in the repository root, with the Go fixture module selected through a go.work of its own. */
function make(t, args, env = {}) {
  return spawnSync('make', args, {
    cwd: root, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, GOWORK: workspaceFor(t), BENCH_TIMEOUT: '20', ...env },
  });
}

test('make benchmark-go fails a benchmark build whose link reports an object newer than the link, and names the object and both versions', { timeout: 150000 }, (t) => {
  const result = make(t, ['benchmark-go', `BENCH_GO_PACKAGE=${goLinked}`]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /ld built \S+ for macOS 27\.0, newer than the macOS 14\.4 of the link/, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /^RUN  Benchmark/m, 'a benchmark of a build with a linker failure ran');
});

// Both benchmark targets link the native library of native/darwin: benchmark-go reads its checksum for the cgo define, and the
// Rust host reads it through pkg-config. The dry run names the native build as a command that runs before the benchmark command.
test('make benchmark-go and make benchmark-rust build the native library before their benchmarks run', { timeout: 60000 }, () => {
  for (const target of ['benchmark-go', 'benchmark-rust']) {
    // MAKE=true keeps the recursive make of the native build from running, so the dry run names it and runs nothing.
    const result = spawnSync('make', ['-n', target, 'MAKE=true'], { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const lines = result.stdout.split('\n');
    const build = lines.findIndex((line) => /-C native\/darwin\b/.test(line));
    const benchmark = lines.findIndex((line) => /scripts\/benchmarks\.mjs/.test(line));
    assert.notEqual(build, -1, `${target} does not build the native library of native/darwin`);
    assert.ok(build < benchmark, `${target} runs its benchmark before the native build`);
  }
});

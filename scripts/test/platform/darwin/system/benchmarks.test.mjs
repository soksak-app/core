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

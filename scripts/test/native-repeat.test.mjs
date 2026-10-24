// Verifies that `make -C native/darwin repeat` and `repeat-suite` name each native test when it starts and report its result and
// elapsed time, as `make test` does through scripts/native-tests.mjs. The test executables are replaced by fake executables in a
// temporary build folder: `make -o <file>` treats each fake as up to date, so the Makefile builds nothing and the fakes run as the
// tests would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const native = resolve(import.meta.dirname, '../../native/darwin');

function fake(directory, relative, body) {
  const path = join(directory, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

// The entries of NATIVE_TESTS in the Makefile, as `<executable>[,<argument>...]`.
function nativeTestEntries() {
  const lines = readFileSync(join(native, 'Makefile'), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith('NATIVE_TESTS = '));
  const entries = [];
  for (let i = start; i < lines.length; i += 1) {
    const text = (i === start ? lines[i].slice('NATIVE_TESTS = '.length) : lines[i]).trim();
    const continues = text.endsWith('\\');
    const entry = text.replace(/\\$/, '').trim();
    if (entry !== '') entries.push(entry);
    if (!continues) break;
  }
  return entries;
}

test('make repeat names the native test of each run, reports its result and elapsed time, and stops at a failed run', (t) => {
  const build = mkdtempSync(join(tmpdir(), 'soksak-native-repeat-'));
  t.after(() => rmSync(build, { recursive: true }));
  const executable = fake(build, 'fake_test', 'counter="$0.count"; n=$(cat "$counter" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$counter"; echo "probe $n"; [ "$n" -lt 2 ]');
  const result = spawnSync('make', ['-C', native, 'repeat', 'TEST=fake_test', 'COUNT=3', `BUILD=${build}`, '-o', executable], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.match(result.stdout, /^RUN  fake_test \(1 running, limit 120\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS fake_test \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAIL fake_test \d+\.\d{3}s exit 1$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^  probe 2$/m, 'the output of the failed run is missing');
  assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('RUN  ')).length, 2, result.stdout);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /FAIL: fake_test run 2 of 3; /, result.stdout + result.stderr);
});

test('repeat-activation-backspace forwards its focused variant and stops at its first failed run', (t) => {
  const build = mkdtempSync(join(tmpdir(), 'soksak-native-activation-repeat-'));
  t.after(() => rmSync(build, { recursive: true }));
  const executable = fake(build, 'image_region_ime_test', 'counter="$0.count"; n=$(cat "$counter" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$counter"; echo "arg:$1 run:$n"; [ "$1" = "--backspace-trace" ] && [ "$n" -lt 2 ]');
  const result = spawnSync('make', ['-C', native, 'repeat-activation-backspace', 'COUNT=3', `BUILD=${build}`, '-o', executable], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.match(result.stdout, /^RUN  image_region_ime_test --backspace-trace \(1 running, limit 120\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS image_region_ime_test --backspace-trace \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAIL image_region_ime_test --backspace-trace \d+\.\d{3}s exit 1$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^  arg:--backspace-trace run:2$/m, 'the failed run output is missing');
  assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('RUN  image_region_ime_test')).length, 2, result.stdout);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /FAIL: image_region_ime_test --backspace-trace run 2 of 3; /, result.stdout + result.stderr);
});

test('make repeat-suite shows the runner output of every run of the suite, and passes when each test passes', (t) => {
  const build = mkdtempSync(join(tmpdir(), 'soksak-native-suite-'));
  t.after(() => rmSync(build, { recursive: true }));
  const entries = nativeTestEntries();
  const executables = entries.map((entry) => {
    const [name, ...args] = entry.split(',');
    return fake(build, name, `echo "ran ${name} ${args.join(' ')}"`);
  });
  const result = spawnSync('make', ['-C', native, 'repeat-suite', 'COUNT=1', `BUILD=${build}`, ...executables.flatMap((path) => ['-o', path])], {
    encoding: 'utf8', timeout: 120000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const entry of entries) {
    const name = entry.split(',')[0];
    assert.match(result.stdout, new RegExp(`^RUN  ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `, 'm'), `no RUN line for ${name}`);
  }
  assert.match(result.stdout, /^PASS: test suite passed 1 consecutive runs$/m, result.stdout + result.stderr);
});

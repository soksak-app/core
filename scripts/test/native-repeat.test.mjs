// Verifies that `make -C native/darwin repeat` and `repeat-suite` name each native test when it starts and report its result and
// elapsed time, as `make test` does through scripts/native-tests.mjs. The test executables are fixture programs of
// scripts/test/fixtures/native-repeat, compiled by the real clang into a temporary build folder: `make -o <file>` treats each one as
// up to date, so the Makefile builds nothing and the fixture programs run as the tests would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const native = resolve(import.meta.dirname, '../../native/darwin');
const fixtures = fileURLToPath(new URL('./fixtures/native-repeat/', import.meta.url));

// Compiles the fixture program source of fixtures/native-repeat into <build>/<name> with clang.
function compile(build, name, source) {
  const path = join(build, name);
  const result = spawnSync('clang', ['-o', path, join(fixtures, source)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return path;
}

// The entries of the unit suite list NATIVE_TESTS in the Makefile, which repeat-suite runs, as `<executable>[,<argument>...]`.
function nativeTestEntries() {
  const lines = readFileSync(join(native, 'Makefile'), 'utf8').split('\n');
  const entries = [];
  for (const list of ['NATIVE_TESTS = ']) {
    const start = lines.findIndex((line) => line.startsWith(list));
    assert.notEqual(start, -1, `the Makefile has no ${list.trim()} list`);
    for (let i = start; i < lines.length; i += 1) {
      const text = (i === start ? lines[i].slice(list.length) : lines[i]).trim();
      const continues = text.endsWith('\\');
      const entry = text.replace(/\\$/, '').trim();
      if (entry !== '') entries.push(entry);
      if (!continues) break;
    }
  }
  return entries;
}

test('make repeat names the native test of each run, reports its result and elapsed time, and stops at a failed run', (t) => {
  const build = mkdtempSync(join(tmpdir(), 'soksak-native-repeat-'));
  t.after(() => rmSync(build, { recursive: true }));
  const executable = compile(build, 'repeat_probe_test', 'repeat_probe.c');
  const result = spawnSync('make', ['-C', native, 'repeat', 'TEST=repeat_probe_test', 'COUNT=3', `BUILD=${build}`, '-o', executable], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.match(result.stdout, /^RUN  repeat_probe_test \(1 running, limit 120\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS repeat_probe_test \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAIL repeat_probe_test \d+\.\d{3}s exit 1$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^  probe 2$/m, 'the output of the failed run is missing');
  assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('RUN  ')).length, 2, result.stdout);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /FAIL: repeat_probe_test run 2 of 3; /, result.stdout + result.stderr);
});

test('test-app-activation-backspace-repeat forwards its focused variant and stops at its first failed run', (t) => {
  const build = mkdtempSync(join(tmpdir(), 'soksak-native-activation-repeat-'));
  t.after(() => rmSync(build, { recursive: true }));
  const executable = compile(build, 'image_region_ime_test', 'image_region_ime_test.c');
  const probe = compile(build, 'ime_source_probe', 'ime_source_probe.c');
  // The source probe fixture prints this snapshot, so the comparison after the run has the state that the run started with.
  writeFileSync(`${probe}.snapshot`, '{"source":"com.apple.inputmethod.Korean.2SetKorean","frontmostPID":100,"processPID":200}\n');
  const evidence = join(build, 'evidence');
  const result = spawnSync('make', ['-C', native, 'test-app-activation-backspace-repeat', 'COUNT=3', `BUILD=${build}`, `ACTIVATION_REPEAT_EVIDENCE=${evidence}`, '-o', executable, '-o', probe], {
    encoding: 'utf8', timeout: 60000,
  });
  // The evidence of the repeat is kept on purpose, so it lies in the folder that the caller names and not in the temporary folder.
  assert.match(result.stdout, new RegExp(`^EVIDENCE: ${evidence}/F239-47-8\\.[A-Za-z0-9]{6}$`, 'm'), result.stdout + result.stderr);
  assert.match(result.stdout, /^RUN  image_region_ime_test --backspace-trace-abc-baseline \(1 running, limit 120\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS image_region_ime_test --backspace-trace-abc-baseline \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAIL image_region_ime_test --backspace-trace-abc-baseline \d+\.\d{3}s exit 1$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^  arg:--backspace-trace-abc-baseline run:2$/m, 'the failed run output is missing');
  assert.match(result.stdout, /post-exit source\/app .*matches pre-run/, 'the independent source probe was not compared');
  assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('RUN  image_region_ime_test')).length, 2, result.stdout);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /FAIL: image_region_ime_test --backspace-trace-abc-baseline run 2 of 3; /, result.stdout + result.stderr);
});

test('the activation repeat keeps its evidence under target/activation-repeat of the repository by default', () => {
  const result = spawnSync('make', ['-n', '-C', native, 'test-app-activation-backspace-repeat', 'COUNT=1', '-o', join(native, 'build/image_region_ime_test'), '-o', join(native, 'build/ime_source_probe')], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const kept = resolve(native, '../../target/activation-repeat');
  assert.ok(result.stdout.includes(`mktemp -d "${kept}/F239-47-8.XXXXXX"`), result.stdout);
});

test('the activation build alias resolves absolute targets without running either executable', (t) => {
  const build = mkdtempSync(join(tmpdir(), 'soksak-native-activation-build-'));
  t.after(() => rmSync(build, { recursive: true }));
  // The marker program creates <path>.executed when it runs, so a run of either target is visible after the build.
  const activation = compile(build, 'image_region_ime_test', 'run_marker.c');
  const probe = compile(build, 'ime_source_probe', 'run_marker.c');
  const result = spawnSync('make', ['-C', native, 'build-ime-activation-target', `BUILD=${build}`, '-o', activation, '-o', probe], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(`${activation}.executed`), false, 'the activation executable was run by its build target');
  assert.equal(existsSync(`${probe}.executed`), false, 'the read-only probe executable was run by the build target');
});

test('make repeat-suite shows the runner output of every run of the suite, and passes when each test passes', (t) => {
  const build = mkdtempSync(join(tmpdir(), 'soksak-native-suite-'));
  t.after(() => rmSync(build, { recursive: true }));
  const entries = nativeTestEntries();
  // One compiled fixture program serves every entry: it prints the arguments that the runner passes after the executable name.
  const program = compile(build, 'suite_probe', 'suite_probe.c');
  const executables = entries.map((entry) => {
    const name = entry.split(',')[0];
    const path = join(build, name);
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(program, path);
    return path;
  });
  // The runner gives each of the runs of the suite its own limit and reports it, so the run of the whole suite has no limit of
  // its own: one limit over every entry of NATIVE_TESTS would grow with the list and judge the load of the machine.
  const result = spawnSync('make', ['-C', native, 'repeat-suite', 'COUNT=1', `BUILD=${build}`, ...executables.flatMap((path) => ['-o', path])], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const entry of entries) {
    const name = entry.split(',')[0];
    assert.match(result.stdout, new RegExp(`^RUN  ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `, 'm'), `no RUN line for ${name}`);
  }
  assert.match(result.stdout, /^PASS: test suite passed 1 consecutive runs$/m, result.stdout + result.stderr);
});

test('make repeat in the process-identity package names its test of each run, reports its result and elapsed time, and stops at a failed run', (t) => {
  const build = mkdtempSync(join(tmpdir(), 'soksak-process-identity-repeat-'));
  t.after(() => rmSync(build, { recursive: true }));
  const executable = compile(build, 'process_identity_test', 'repeat_probe.c');
  const result = spawnSync('make', ['-C', join(native, 'process-identity'), 'repeat', 'TEST=process_identity_test', 'COUNT=3', `BUILD=${build}`, '-o', executable], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.match(result.stdout, /^RUN  process_identity_test \(1 running, limit 120\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS process_identity_test \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAIL process_identity_test \d+\.\d{3}s exit 1$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^  probe 2$/m, 'the output of the failed run is missing');
  assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('RUN  ')).length, 2, result.stdout);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /FAIL: process_identity_test run 2 of 3; /, result.stdout + result.stderr);
});

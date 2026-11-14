// Verifies that `make repeat-rust` names each test of a package when it starts, reports its result and elapsed time, kills a test at
// its own limit, selects the Cargo target and the features, forwards the profile and the deployment target, and fails a build whose
// link reports an object newer than the link. The packages are the tracked fixture crates of scripts/test/fixtures/repeat-rust, each
// a workspace of its own, built and run by the real cargo. Each run builds into a folder of its own (CARGO_TARGET_DIR).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cargoTargetArgs, runRustTests } from '../rust-tests.mjs';

const root = resolve(import.meta.dirname, '../..');
const manifest = 'scripts/test/fixtures/repeat-rust/Cargo.toml';
const build = (name) => `scripts/test/fixtures/repeat-rust/${name}/Cargo.toml`;

/** A folder that holds the Cargo target of one test, removed when the test ends. */
function targetFolder(t) {
  const directory = mkdtempSync(join(tmpdir(), 'soksak-rust-repeat-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** The test executables that cargo built into the `profile` folder of the target: `<target>-<16 hex digits>` files. */
function testExecutables(target, profile = 'debug') {
  const deps = join(target, profile, 'deps');
  return existsSync(deps) ? readdirSync(deps).filter((name) => /^[a-z]+-[0-9a-f]{16}$/.test(name)) : [];
}

/** Runs `make` in the repository root with the Cargo target of the test and the manifest of the fixture (or of `file`). */
function make(t, args, { file = manifest, env = {} } = {}) {
  const target = targetFolder(t);
  const result = spawnSync('make', [...args, `MANIFEST=${file}`], {
    cwd: root, env: { ...process.env, CARGO_TARGET_DIR: target, ...env }, encoding: 'utf8', timeout: 240000,
  });
  return { ...result, target };
}

/** Runs the runner script with the arguments, the manifest of the fixture (or of `file`) and the Cargo target of the test. */
function cli(t, args, { file = manifest, env = {} } = {}) {
  const target = targetFolder(t);
  const result = spawnSync(process.execPath, ['scripts/rust-tests.mjs', '--manifest', file, ...args], {
    cwd: root, env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: '14.4', CARGO_TARGET_DIR: target, ...env }, encoding: 'utf8', timeout: 240000,
  });
  return { ...result, target };
}

const docTest = 'src/lib.rs - doc_example (line 3)';

for (const profile of ['release', 'owner-custom']) {
  test(`Rust CLI forwards ${profile} profile to build and both doctest paths`, { timeout: 240000 }, (t) => {
    const result = cli(t, ['--package', 'fixture', '--profile', profile, '--test', docTest]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^PASS src\/lib\.rs - doc_example \(line 3\) \d+\.\d{3}s$/m, result.stdout + result.stderr);
    assert.ok(existsSync(join(result.target, profile, 'deps')), `the build did not use the ${profile} profile`);
  });
}

test('make repeat-rust forwards its explicit Cargo profile without changing test selection', { timeout: 240000 }, (t) => {
  const result = make(t, ['repeat-rust', 'PACKAGE=fixture', 'COUNT=1', 'RUST_PROFILE=release', `TEST=${docTest}`]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS src\/lib\.rs - doc_example \(line 3\) \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /^RUN  fixture::/m, 'a test outside TEST ran');
  assert.ok(existsSync(join(result.target, 'release', 'deps')), 'the build did not use the release profile');
});

test('runRustTests rejects empty and nonstring profiles before invoking Cargo', async (t) => {
  const target = targetFolder(t);
  const previous = process.env.CARGO_TARGET_DIR;
  process.env.CARGO_TARGET_DIR = target;
  t.after(() => {
    if (previous === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = previous;
  });
  for (const profile of ['', ' ', null, 1, false]) {
    await assert.rejects(runRustTests({ manifest: join(root, manifest), package: 'fixture', profile, count: 1, timeoutMs: 1000, write() {} }), /--profile must be a nonempty Cargo profile name/);
    assert.deepEqual(readdirSync(target), [], 'invalid profile reached Cargo');
  }
});

test('Rust owner CLI reports captured Cargo compiler failure output', { timeout: 240000 }, (t) => {
  const result = cli(t, ['--package', 'broken', '--test-target', 'lib'], { file: build('broken') });
  assert.notEqual(result.status, 0, 'a failed build must fail the check');
  assert.ok((result.stdout + result.stderr).includes('error[E0308]: mismatched types'), `captured Cargo diagnostic is missing: ${result.stdout}${result.stderr}`);
  assert.deepEqual(testExecutables(result.target), [], 'a failed build left a test executable');
});

test('Rust owner CLI reports captured Cargo metadata failure output', { timeout: 240000 }, (t) => {
  // The fault injection point of the metadata stage names a manifest that does not exist; cargo metadata reports it, and the build
  // of the test (the stage before) has already run with the manifest of the fixture.
  const missing = join(targetFolder(t), 'missing', 'Cargo.toml');
  const result = cli(t, ['--package', 'fixture', '--test-target', 'lib'], { env: { SOKSAK_FAULT_METADATA_MANIFEST: missing } });
  assert.notEqual(result.status, 0, 'a failed discovery must fail the check');
  assert.match(result.stderr, /manifest path `[^`]*missing\/Cargo\.toml` does not exist/, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /^(RUN|PASS) /m, 'a test ran after the metadata stage failed');
});

test('make repeat-rust selects only the lib Cargo target before discovery', { timeout: 240000 }, (t) => {
  const result = make(t, ['repeat-rust', 'PACKAGE=fixture', 'COUNT=1', 'TEST=fixture::library_case', 'TEST_TARGET=lib']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS fixture::library_case \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /^RUN  .*(integration_case|doc_example)/m, 'a test of another target ran');
  const executables = testExecutables(result.target);
  assert.ok(executables.length === 1 && executables[0].startsWith('fixture-'), `the built executables are ${executables}`);
});

test('make repeat-rust selects only the test:integration Cargo target before discovery', { timeout: 240000 }, (t) => {
  const result = make(t, ['repeat-rust', 'PACKAGE=fixture', 'COUNT=1', 'TEST=fixture::integration_case', 'TEST_TARGET=test:integration']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS fixture::integration_case \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /^RUN  .*(library_case|doc_example)/m, 'a test of another target ran');
  const executables = testExecutables(result.target);
  assert.ok(executables.length === 1 && executables[0].startsWith('integration-'), `the built executables are ${executables}`);
});

test('make repeat-rust keeps package-wide target and doctest discovery by default', { timeout: 240000 }, (t) => {
  const result = make(t, ['repeat-rust', 'PACKAGE=fixture', 'COUNT=1']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of ['fixture::library_case', 'fixture::integration_case', docTest]) {
    assert.ok(result.stdout.split('\n').some((line) => line.startsWith('PASS ') && line.includes(name)), `${name} did not pass: ${result.stdout}`);
  }
});

test('make repeat-rust rejects an invalid Cargo target before invoking Cargo', { timeout: 240000 }, (t) => {
  const result = make(t, ['repeat-rust', 'PACKAGE=fixture', 'COUNT=1', 'TEST_TARGET=test:bad/name']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /--test-target must be lib or test:<Cargo target name>/, result.stdout + result.stderr);
  assert.equal(existsSync(join(result.target, 'debug')), false, 'Cargo ran before the target selector was rejected');
});

test('make repeat-rust rejects shell syntax in a Cargo target without executing it', { timeout: 240000 }, (t) => {
  const target = targetFolder(t);
  const marker = join(target, 'injected-command-ran');
  const result = spawnSync('make', ['repeat-rust', 'PACKAGE=fixture', 'COUNT=1', `TEST_TARGET=test:bad'; touch ${marker}; #`, `MANIFEST=${manifest}`], {
    cwd: root, env: { ...process.env, CARGO_TARGET_DIR: target }, encoding: 'utf8', timeout: 240000,
  });
  assert.equal(existsSync(marker), false, 'shell syntax in the selector ran as a command');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(target, 'debug')), false, 'Cargo ran before the selector was rejected');
});

test('runRustTests rejects an explicitly empty Cargo target before invoking Cargo', async (t) => {
  const target = targetFolder(t);
  const previous = process.env.CARGO_TARGET_DIR;
  process.env.CARGO_TARGET_DIR = target;
  t.after(() => {
    if (previous === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = previous;
  });
  await assert.rejects(runRustTests({
    manifest: join(root, manifest), package: 'fixture', testTarget: '', count: 1, timeoutMs: 1000, write() {},
  }), /--test-target must be lib or test:<Cargo target name>/);
  assert.deepEqual(readdirSync(target), [], 'Cargo ran before the empty selector was rejected');
});

test('cargoTargetArgs rejects non-string selectors instead of coercing them', () => {
  assert.throws(() => cargoTargetArgs(['test:integration']), /--test-target must be a string/);
  assert.throws(() => cargoTargetArgs({ toString: () => 'test:integration' }), /--test-target must be a string/);
});

test('make repeat-rust names each test when it starts, reports its result and elapsed time, and kills a test at its limit', { timeout: 240000 }, (t) => {
  const result = make(t, ['repeat-rust', 'PACKAGE=fixture', 'COUNT=1', 'TEST_TIMEOUT=2']);
  assert.match(result.stdout, /^RUN  fixture::alpha \(1 running, limit 2\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS fixture::alpha \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^RUN  fixture::beta \(1 running, limit 2\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^TIME fixture::beta \d+\.\d{3}s exceeded 2\.000s and was killed(?:; left running: .*)?$/m, result.stdout + result.stderr);
  const killed = /^TIME fixture::beta (\d+)\.\d{3}s/m.exec(result.stdout);
  assert.ok(killed && Number(killed[1]) < 6, `beta ran to its own sleep instead of its limit: ${result.stdout}`);
  // make exits with status 2 when a recipe fails; the run fails with the FAIL line of the runner.
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAIL: fixture run 1 of 1; load /m, result.stdout + result.stderr);
});

test('make repeat-rust passes its features to every cargo test call', { timeout: 240000 }, (t) => {
  const withFeature = make(t, ['repeat-rust', 'PACKAGE=fixture', 'COUNT=1', 'FEATURES=diagnostics', 'TEST=fixture::feature_case']);
  assert.equal(withFeature.status, 0, withFeature.stdout + withFeature.stderr);
  assert.match(withFeature.stdout, /^PASS fixture::feature_case \d+\.\d{3}s$/m, withFeature.stdout + withFeature.stderr);
  const withoutFeature = make(t, ['repeat-rust', 'PACKAGE=fixture', 'COUNT=1', 'TEST=fixture::feature_case']);
  assert.notEqual(withoutFeature.status, 0, withoutFeature.stdout + withoutFeature.stderr);
  assert.match(withoutFeature.stderr, /fixture has no test named fixture::feature_case/, withoutFeature.stdout + withoutFeature.stderr);
});

test('Rust repeat discovery locks Cargo test and metadata resolution', { timeout: 240000 }, (t) => {
  const result = cli(t, ['--package', 'unlocked', '--test-target', 'lib'], { file: build('unlocked') });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /--locked/, result.stdout + result.stderr);
  assert.equal(existsSync(join(root, 'scripts/test/fixtures/repeat-rust/unlocked/Cargo.lock')), false, '--locked wrote a lock file');
});

test('make repeat-rust runs each documentation test of the library with its own name, result and elapsed time', { timeout: 240000 }, (t) => {
  // A documentation test is compiled by each run, so its limit is 60 seconds; the limit of the kill test is too short for a compile.
  const result = make(t, ['repeat-rust', 'PACKAGE=fixture', 'COUNT=1', `TEST=${docTest}`, 'TEST_TIMEOUT=60']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^RUN  src\/lib\.rs - doc_example \(line 3\) \(1 running, limit 60\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS src\/lib\.rs - doc_example \(line 3\) \d+\.\d{3}s$/m, result.stdout + result.stderr);
});

for (const target of ['repeat-rust', 'test-rust-alone']) {
  test(`make ${target} applies the declared deployment environment to every Cargo call`, { timeout: 240000 }, (t) => {
    const args = [target, 'PACKAGE=fixture', 'MACOS_MINIMUM=14.4'];
    if (target === 'repeat-rust') args.push('COUNT=1', 'TEST=fixture::deployment_target', 'TEST_TARGET=lib');
    // The fixture reads the deployment target that Cargo gave its build, so a build under 10.9 would fail the test.
    const result = make(t, args, { env: { MACOSX_DEPLOYMENT_TARGET: '10.9' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^PASS fixture::deployment_target \d+\.\d{3}s$/m, result.stdout + result.stderr);
  });
}

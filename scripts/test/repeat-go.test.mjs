// Verifies that `make repeat-go` names each test of a Go package when it starts, reports its result and elapsed time, lets a test
// end itself at its own limit with its stacks, passes the build tags, and judges a package pattern by its test packages. The
// packages are the tracked fixture module scripts/test/fixtures/repeat-go, built and run by the real go toolchain. go.work of the
// repository does not list the fixture, so each run selects it through a go.work file of its own folder (GOWORK). The native
// environment is declared by the fixture declaration native-packages.json, and the cgo flags are observed through the map file
// that the external linker writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const fixture = join(root, 'scripts/test/fixtures/repeat-go');
const nativeDeclaration = join(fixture, 'native-packages.json');

/** A folder holding a go.work that uses the fixture module, and the path of that go.work. */
function workspaceFor(t) {
  const directory = mkdtempSync(join(tmpdir(), 'soksak-go-repeat-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // The go command writes the workspace file of the folder: the go version of its toolchain and the use of the fixture module.
  const { GOWORK, ...environment } = process.env;
  const created = spawnSync('go', ['work', 'init', fixture], { cwd: directory, env: environment, encoding: 'utf8' });
  assert.equal(created.status, 0, created.stdout + created.stderr);
  return join(directory, 'go.work');
}

/** Runs `make` with the arguments in the repository root, with the workspace of the fixture module. */
function make(t, args) {
  return spawnSync('make', args, {
    cwd: root, env: { ...process.env, GOWORK: workspaceFor(t) }, encoding: 'utf8', timeout: 60000,
  });
}

/** Runs the Go test runner script with the arguments, the workspace of the fixture module and the environment `env`. */
function runGoTests(t, args, env = {}) {
  return spawnSync(process.execPath, ['scripts/go-tests.mjs', ...args], {
    cwd: root, env: { ...process.env, GOWORK: workspaceFor(t), ...env }, encoding: 'utf8', timeout: 240000,
  });
}

/** A folder of the test, removed when the test ends. */
function folderFor(t) {
  const directory = mkdtempSync(join(tmpdir(), 'soksak-go-repeat-files-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const fixturePackage = (name) => `./scripts/test/fixtures/repeat-go/${name}`;

test('make repeat-go names each test when it starts, reports its result and elapsed time, and a test at its limit ends itself with its stacks', (t) => {
  const { stdout, stderr, status } = make(t, ['repeat-go', `PACKAGE=${fixturePackage('run')}`, 'COUNT=1', 'TEST_TIMEOUT=2']);
  assert.match(stdout, /^RUN  TestAlpha \(1 running, limit 2\.000s\)$/m, stdout + stderr);
  assert.match(stdout, /^PASS TestAlpha \d+\.\d{3}s$/m, stdout + stderr);
  assert.match(stdout, /^RUN  TestBeta \(1 running, limit 2\.000s\)$/m, stdout + stderr);
  assert.match(stdout, /^TIME TestBeta \d+\.\d{3}s exceeded 2\.000s and ended itself with its stacks(?:; left running: .*)?$/m, stdout + stderr);
  // The testing package of Go ends the test at its -test.timeout with this panic; the runner sends no signal at the limit.
  assert.match(stdout, /^  panic: test timed out after 2s$/m, `the test did not end with the timeout panic of the testing package: ${stdout}`);
  assert.doesNotMatch(stdout, /\bSIG[A-Z]+\b/, `the runner signalled the test at its limit: ${stdout}`);
  assert.match(stdout, /^  goroutine \d+ \[sleep\]:$/m, `the stacks of the test over its limit are not in the output: ${stdout}`);
  assert.match(stdout, /repeatgo\/run\.sleepInFixture/, `the stack of the test over its limit is not in the output: ${stdout}`);
  const ended = /^TIME TestBeta (\d+)\.\d{3}s/m.exec(stdout);
  assert.ok(ended && Number(ended[1]) < 6, `TestBeta ran to its own sleep instead of its limit: ${stdout}`);
  assert.doesNotMatch(stdout, /BenchmarkGamma/, 'a benchmark ran as a test');
  assert.notEqual(status, 0, stdout + stderr);
  assert.match(stdout, /^FAIL: \S+ run 1 of 1; load /m, stdout + stderr);
});

test('make repeat-go builds a package whose test file has a build tag only with the tag, and passes the tag to the list and the test build', (t) => {
  const without = make(t, ['repeat-go', `PACKAGE=${fixturePackage('tagged')}`, 'COUNT=1', 'TEST=TestTagged']);
  assert.notEqual(without.status, 0, without.stdout + without.stderr);
  assert.match(without.stderr, /has no test files built with tags ''/, without.stdout + without.stderr);
  const withTag = make(t, ['repeat-go', `PACKAGE=${fixturePackage('tagged')}`, 'COUNT=1', 'TAGS=diagnostics', 'TEST=TestTagged']);
  assert.equal(withTag.status, 0, withTag.stdout + withTag.stderr);
  assert.match(withTag.stdout, /^PASS TestTagged \d+\.\d{3}s$/m, withTag.stdout + withTag.stderr);
});

test('make repeat-go selects only the named tests', (t) => {
  const { stdout, stderr, status } = make(t, ['repeat-go', `PACKAGE=${fixturePackage('run')}`, 'COUNT=1', 'TEST=TestAlpha']);
  assert.equal(status, 0, stdout + stderr);
  assert.match(stdout, /^PASS TestAlpha \d+\.\d{3}s$/m, stdout + stderr);
  assert.doesNotMatch(stdout, /TestBeta/, 'a test outside TEST ran');
});

test('make repeat-go gives each test the deadline of its limit', (t) => {
  const { stdout, stderr, status } = make(t, ['repeat-go', `PACKAGE=${fixturePackage('deadline')}`, 'COUNT=1', 'TEST=TestDeadline', 'TEST_TIMEOUT=7']);
  assert.equal(status, 0, stdout + stderr);
  assert.match(stdout, /^PASS TestDeadline \d+\.\d{3}s$/m, stdout + stderr);
});

test('make repeat-go fails a package whose test files are not built', (t) => {
  const { stdout, stderr, status } = make(t, ['repeat-go', `PACKAGE=${fixturePackage('plain')}`, 'COUNT=1', 'TEST=TestAlpha']);
  assert.notEqual(status, 0, stdout + stderr);
  assert.match(stderr, /has no test files built with tags ''/, stdout + stderr);
});

test('make repeat-go passes a pattern whose tested package passed while a support package has no test files', (t) => {
  const { stdout, stderr, status } = make(t, ['repeat-go', `PACKAGE=${fixturePackage('tests')}/...`, 'COUNT=1', 'TEST=TestAlpha']);
  assert.equal(status, 0, stdout + stderr);
  assert.match(stdout, /^PASS TestAlpha \d+\.\d{3}s$/m, stdout + stderr);
  assert.match(stdout, /1 of 1 runs pass/, stdout + stderr);
});

test('make repeat-go fails a test build whose link reports an object newer than the link, and names the object and both versions', (t) => {
  const result = make(t, ['repeat-go', `PACKAGE=${fixturePackage('cgolink')}`, 'COUNT=1', 'TEST=TestAlpha']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /ld built \S+ for macOS 27\.0, newer than the macOS 14\.4 of the link/, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /^RUN  TestAlpha/m, 'a test of a build with a linker failure ran');
});

test('make repeat-go fails a run in which no test matched', (t) => {
  const { stdout, stderr, status } = make(t, ['repeat-go', `PACKAGE=${fixturePackage('run')}`, 'COUNT=1', 'TEST=TestMissing']);
  assert.notEqual(status, 0, stdout + stderr);
  assert.match(stderr, /no test matching TestMissing/, stdout + stderr);
});

test('Go test runner preserves the selected native environment through graph, build, listing and execution without cgo-only flags in CGO0', (t) => {
  const directory = folderFor(t);
  const production = join(directory, 'declared-production.dylib');
  const testLibrary = join(directory, 'declared-test.dylib');
  writeFileSync(production, 'production artifact');
  writeFileSync(testLibrary, 'test artifact');
  const report = join(directory, 'report.txt');
  const map = join(directory, 'cgo0.map');
  const result = runGoTests(t, ['--package', fixturePackage('nativeprod'), '--test', 'TestNativeEnvironment', '--count', '1', '--timeout', '60',
    '--native-packages', nativeDeclaration, '--ldflags=-X fixture.soksak/repeatgo/nativeprod.value=generic', `--cgo-ldflags=-extldflags -Wl,-map,${map}`],
  { CGO_ENABLED: '0', SOKSAK_NATIVE_LIBRARY: production, SOKSAK_NATIVE_TEST_LIBRARY: testLibrary, SOKSAK_FIXTURE_REPORT: report });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // The report is written by the test binary, which received the environment of the selected profile.
  assert.equal(readFileSync(report, 'utf8'), `CGO_ENABLED=0\nSOKSAK_NATIVE_LIBRARY=${production}\nSOKSAK_NATIVE_TEST_LIBRARY=${testLibrary}\nvalue=generic\n`);
  assert.equal(existsSync(map), false, 'a CGO0 build applied the cgo linker flags');
});

test('Go test runner keeps generic linker flags and applies cgo linker flags to a CGO1 build', (t) => {
  const map = join(folderFor(t), 'cgo1.map');
  const result = runGoTests(t, ['--package', fixturePackage('cgomap'), '--test', 'TestFlags', '--count', '1', '--timeout', '60',
    '--ldflags=-X fixture.soksak/repeatgo/cgomap.value=generic', `--cgo-ldflags=-extldflags -Wl,-map,${map}`], { CGO_ENABLED: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS TestFlags \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.ok(existsSync(map) && statSync(map).size > 0, 'a CGO1 build did not apply the cgo linker flags');
});

test('native input diagnostics print only the native and cgo whitelist', (t) => {
  const result = spawnSync(process.execPath, ['scripts/go-repeat-inputs.mjs', fixturePackage('run')], {
    cwd: root, env: { ...process.env, GOWORK: workspaceFor(t), CGO_ENABLED: '0', SOKSAK_UNRELATED_SECRET: 'private-diagnostic-sentinel' },
    encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /private-diagnostic-sentinel|SOKSAK_UNRELATED_SECRET/);
  const diagnostic = JSON.parse(result.stdout);
  assert.equal(diagnostic.cgoEnabled, false);
  const allowed = new Set(['CGO_ENABLED', 'CGO_CFLAGS', 'CGO_CPPFLAGS', 'CGO_CXXFLAGS', 'CGO_LDFLAGS', 'SOKSAK_NATIVE_LIBRARY', 'SOKSAK_NATIVE_TEST_LIBRARY', 'SOKSAK_NATIVE_CALLBACK_ABI_LIBRARY', 'SOKSAK_NATIVE_CALLBACK_WORKER_LIBRARY']);
  assert.ok(Object.keys(diagnostic.env).every((key) => allowed.has(key)), result.stdout);
});

/** Builds the static library of the pkg-config package soksak-darwin in `directory` from the tracked C fixture with `value` as its result, as the native Makefile does. */
function writeStaticLibrary(directory, value) {
  mkdirSync(directory, { recursive: true });
  const compiled = spawnSync('cc', ['-c', `-DFIXTURE_VALUE=${value}`, join(fixture, 'library/value.c'), '-o', join(directory, 'value.o')], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  rmSync(join(directory, 'libfixture.a'), { force: true });
  const archived = spawnSync('ar', ['rcs', join(directory, 'libfixture.a'), join(directory, 'value.o')], { encoding: 'utf8' });
  assert.equal(archived.status, 0, archived.stderr);
  writeFileSync(join(directory, 'soksak-darwin.pc'), [
    `static_library=${join(directory, 'libfixture.a')}`, 'Name: soksak-darwin', 'Description: fixture', 'Version: 1',
    `Libs: -L${directory} -lfixture`, ''].join('\n'));
}

test('Go test runner links the static library that pkg-config names now, also when another location held the same content earlier', (t) => {
  // Go does not hash the output of pkg-config into the build id of a cgo package, so a package built against the library of the
  // first location keeps that -L path. The two libraries have the same content when the first run starts; the first location
  // changes afterwards, and the second run selects the second location.
  const base = folderFor(t);
  const first = join(base, 'first');
  const second = join(base, 'second');
  writeStaticLibrary(first, 1);
  writeStaticLibrary(second, 1);
  const cache = join(base, 'gocache');
  const run = (location, want) => runGoTests(t, ['--package', fixturePackage('staticlink'), '--count', '1', '--timeout', '60'],
    { CGO_ENABLED: '1', GOCACHE: cache, PKG_CONFIG_PATH: location, FIXTURE_STATIC_WANT: String(want) });
  const earlier = run(first, 1);
  assert.equal(earlier.status, 0, earlier.stdout + earlier.stderr);
  writeStaticLibrary(first, 3);
  const later = run(second, 1);
  assert.equal(later.status, 0, later.stdout + later.stderr);
  assert.match(later.stdout, /^PASS TestLinked \d+\.\d{3}s$/m, later.stdout + later.stderr);
});

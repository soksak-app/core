// Verifies the two cases of `make repeat-go` and the Go test runner that need the macOS linker: a test build whose link reports an
// object built for a newer macOS version than the link, and a CGO1 build whose cgo linker flags name the map file with the macOS
// linker option `-map`. The packages are the tracked fixture module scripts/test/fixtures/repeat-go, built and run by the real go
// toolchain on macOS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../../../../..');
const fixture = join(root, 'scripts/test/fixtures/repeat-go');

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

test('make repeat-go fails a test build whose link reports an object newer than the link, and names the object and both versions', (t) => {
  const result = make(t, ['repeat-go', `PACKAGE=${fixturePackage('cgolink')}`, 'COUNT=1', 'TEST=TestAlpha']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /ld built \S+ for macOS 27\.0, newer than the macOS 14\.4 of the link/, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /^RUN  TestAlpha/m, 'a test of a build with a linker failure ran');
});

test('Go test runner keeps generic linker flags and applies cgo linker flags to a CGO1 build', (t) => {
  const map = join(folderFor(t), 'cgo1.map');
  const result = runGoTests(t, ['--package', fixturePackage('cgomap'), '--test', 'TestFlags', '--count', '1', '--timeout', '60',
    '--ldflags=-X fixture.soksak/repeatgo/cgomap.value=generic', `--cgo-ldflags=-extldflags -Wl,-map,${map}`], { CGO_ENABLED: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS TestFlags \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.ok(existsSync(map) && statSync(map).size > 0, 'a CGO1 build did not apply the cgo linker flags');
});

// Verifies that `make repeat-go-package` runs the whole Go package in one `go test` process per run, reports each run as PASS or
// FAIL, passes the tags and the test pattern, and fails when any run fails. The package is the tracked fixture module
// scripts/test/fixtures/repeat-go, built and run by the real go toolchain. go.work of the repository does not list the fixture,
// so each run selects it through a go.work file of its own folder (GOWORK).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const fixture = join(root, 'scripts/test/fixtures/repeat-go');

/** A folder holding a go.work that uses the fixture module, and the path of that go.work. */
function workspaceFor(t) {
  const directory = mkdtempSync(join(tmpdir(), 'soksak-go-package-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { GOWORK, ...environment } = process.env;
  const created = spawnSync('go', ['work', 'init', fixture], { cwd: directory, env: environment, encoding: 'utf8' });
  assert.equal(created.status, 0, created.stdout + created.stderr);
  return join(directory, 'go.work');
}

/** Runs `make` with the arguments in the repository root, with the workspace of the fixture module. */
function make(t, args) {
  return spawnSync('make', args, {
    cwd: root, env: { ...process.env, GOWORK: workspaceFor(t) }, encoding: 'utf8', timeout: 240000,
  });
}

const fixturePackage = './scripts/test/fixtures/repeat-go/run';

test('make repeat-go-package runs the package in one process per run and reports each run as PASS', (t) => {
  const { stdout, stderr, status } = make(t, ['repeat-go-package', `PACKAGE=${fixturePackage}`, 'COUNT=2', 'TEST=^TestAlpha$']);
  assert.equal(status, 0, stdout + stderr);
  assert.match(stdout, /^PASS run 1 of 2$/m, stdout + stderr);
  assert.match(stdout, /^PASS run 2 of 2$/m, stdout + stderr);
  assert.match(stdout, /^\.\/scripts\/test\/fixtures\/repeat-go\/run: 2 of 2 runs pass$/m, stdout + stderr);
});

test('make repeat-go-package reports each failing run and fails when any run fails', (t) => {
  // TestBeta exceeds the limit of 2 seconds in each run, so each of the 2 runs fails.
  const { stdout, stderr, status } = make(t, ['repeat-go-package', `PACKAGE=${fixturePackage}`, 'COUNT=2', 'TEST=^TestBeta$', 'TEST_TIMEOUT=2']);
  assert.notEqual(status, 0, stdout + stderr);
  assert.match(stdout, /^FAIL run 1 of 2$/m, stdout + stderr);
  assert.match(stdout, /^FAIL run 2 of 2$/m, stdout + stderr);
  assert.match(stderr, /^FAIL: repeat-go-package: 2 of 2 runs failed; load /m, stdout + stderr);
});

test('make repeat-go-package refuses a missing PACKAGE and a COUNT that is not a positive integer', (t) => {
  const withoutPackage = make(t, ['repeat-go-package', 'COUNT=1']);
  assert.equal(withoutPackage.status, 2, withoutPackage.stdout + withoutPackage.stderr);
  assert.match(withoutPackage.stderr, /repeat-go-package requires PACKAGE=/, withoutPackage.stdout + withoutPackage.stderr);
  const zeroCount = make(t, ['repeat-go-package', `PACKAGE=${fixturePackage}`, 'COUNT=0']);
  assert.equal(zeroCount.status, 2, zeroCount.stdout + zeroCount.stderr);
  assert.match(zeroCount.stderr, /repeat-go-package requires COUNT=<n> with n >= 1/, zeroCount.stdout + zeroCount.stderr);
});

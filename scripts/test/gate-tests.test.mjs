// Verifies that the test files of the push gate run through the test runner: each file is named when it starts, reported with its
// result and elapsed time, and killed at its own limit. The files are written to a temporary folder outside the repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');

// The gate runs from the push hook, outside a test; NODE_TEST_CONTEXT of this test run would make node --test skip its files.
const environment = (() => { const copy = { ...process.env }; delete copy.NODE_TEST_CONTEXT; return copy; })();

function fixtures(t) {
  const directory = mkdtempSync(join(tmpdir(), 'soksak-gate-tests-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const pass = join(directory, 'pass.test.mjs');
  const hang = join(directory, 'hang.test.mjs');
  writeFileSync(pass, 'import test from "node:test";\ntest("passes", () => {});\n');
  // The timer keeps the event loop busy for 30 seconds, so only the kill at the limit ends the file sooner.
  writeFileSync(hang, 'import test from "node:test";\ntest("hangs", () => new Promise((resolve) => setTimeout(resolve, 30000)));\n');
  // A file whose only test is skipped runs no test.
  const empty = join(directory, 'empty.test.mjs');
  writeFileSync(empty, 'import test from "node:test";\ntest.skip("skipped", () => {});\n');
  return { pass, hang, empty };
}

test('the push gate names each test file when it starts, reports its result and elapsed time, and kills a file at its limit', (t) => {
  const { pass, hang } = fixtures(t);
  const result = spawnSync('node', ['scripts/gate-tests.mjs', '--timeout', '3', hang, pass], { cwd: root, encoding: 'utf8', timeout: 60000, env: environment });
  assert.match(result.stdout, new RegExp(`^RUN  ${pass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(1 running, limit 3\\.000s\\)$`, 'm'), result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^PASS ${pass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d+\\.\\d{3}s$`, 'm'), result.stdout + result.stderr);
  const killed = new RegExp(`^TIME ${hang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)\\.\\d{3}s exceeded 3\\.000s and was killed(?:; left running: .*)?$`, 'm').exec(result.stdout);
  assert.ok(killed, `the hanging file was not reported as a timeout: ${result.stdout}${result.stderr}`);
  assert.ok(Number(killed[1]) < 10, `the file ran ${killed[1]} s instead of its limit`);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
});

test('the push gate passes when every test file passes', (t) => {
  const { pass } = fixtures(t);
  const result = spawnSync('node', ['scripts/gate-tests.mjs', pass], { cwd: root, encoding: 'utf8', timeout: 60000, env: environment });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^TOTAL 1 test ran in 1 file: 1 pass, 0 fail, 0 timeout in /m, result.stdout + result.stderr);
});

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('a gate file that ran no test passes with no test ran, and a gate in which no file ran a test fails with a line that says so', (t) => {
  const { empty } = fixtures(t);
  const result = spawnSync('node', ['scripts/gate-tests.mjs', empty], { cwd: root, encoding: 'utf8', timeout: 60000, env: environment });
  assert.match(result.stdout, new RegExp(`^PASS ${escape(empty)} \\d+\\.\\d{3}s no test ran$`, 'm'), result.stdout + result.stderr);
  assert.match(result.stdout, /^TOTAL 0 tests ran in 1 file: 1 pass, 0 fail, 0 timeout in /m, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAIL no test ran in the 1 file of the run$/m, result.stdout + result.stderr);
  assert.equal(result.status, 1, result.stdout + result.stderr);
});

test('the gate total counts the tests that its files ran, and a gate passes when a file ran a test', (t) => {
  const { pass, empty } = fixtures(t);
  const result = spawnSync('node', ['scripts/gate-tests.mjs', pass, empty], { cwd: root, encoding: 'utf8', timeout: 60000, env: environment });
  assert.match(result.stdout, new RegExp(`^PASS ${escape(pass)} \\d+\\.\\d{3}s$`, 'm'), result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^PASS ${escape(empty)} \\d+\\.\\d{3}s no test ran$`, 'm'), result.stdout + result.stderr);
  assert.match(result.stdout, /^TOTAL 1 test ran in 2 files: 2 pass, 0 fail, 0 timeout in /m, result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

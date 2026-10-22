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
  return { pass, hang };
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
  assert.match(result.stdout, /^TOTAL 1 tests: 1 pass, 0 fail, 0 timeout in /m, result.stdout + result.stderr);
});

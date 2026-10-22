// Verifies that `make node-repeat` runs each repeat of a Node test file through the test runner, ends a repeat at its limit with its
// process group, names each repeat when it starts, and judges a repeat by the passed tests that match the name pattern. The files are
// written to a temporary folder outside the repository and run by the real node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');

function fixture(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'soksak-node-repeat-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const file = join(directory, 'probe.test.mjs');
  writeFileSync(file, `import test from "node:test";\n${source}\n`);
  return file;
}

// The test named hangs keeps the event loop busy for 30 seconds, so only the kill at the run limit ends it sooner.
test('make node-repeat names each run, ends a run that hangs at its limit, and reports the time it was killed', (t) => {
  const file = fixture(t, 'test("hangs", () => new Promise((resolve) => setTimeout(resolve, 30000)));');
  const result = spawnSync('make', ['node-repeat', `FILE=${file}`, 'NAME=hangs', 'COUNT=1', 'TEST_TIMEOUT=2'], {
    cwd: root, encoding: 'utf8', timeout: 60000,
  });
  assert.match(result.stdout, /^RUN  .* \(1 running, limit 2\.000s\)$/m, result.stdout + result.stderr);
  const killed = /^TIME .* (\d+)\.\d{3}s exceeded 2\.000s and was killed(?:; left running: .*)?$/m.exec(result.stdout);
  assert.ok(killed, `the hanging run was not reported as a timeout: ${result.stdout}${result.stderr}`);
  assert.ok(Number(killed[1]) < 10, `the run ended after ${killed[1]} s instead of its limit`);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAIL: .* run 1 of 1; load /m, result.stdout + result.stderr);
});

test('make node-repeat runs the matching tests in every repeat and reports the count of passing runs', (t) => {
  const file = fixture(t, 'test("owning case", () => {});\ntest("other case", () => {});');
  const result = spawnSync('make', ['node-repeat', `FILE=${file}`, 'NAME=owning case', 'COUNT=2'], {
    cwd: root, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('RUN  ')).length, 2, result.stdout);
  assert.match(result.stdout, /2 of 2 runs pass/, result.stdout);
  assert.match(result.stdout, /^\s*ok \d+ - owning case/m, 'the passed test of a run is not reported');
});

test('make node-repeat stops at the first failed run and reports its output', (t) => {
  const file = fixture(t, 'test("owning case", () => { throw new Error("boom"); });');
  const result = spawnSync('make', ['node-repeat', `FILE=${file}`, 'NAME=owning case', 'COUNT=2'], {
    cwd: root, encoding: 'utf8', timeout: 60000,
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('RUN  ')).length, 1, result.stdout);
  assert.match(result.stdout, /^FAIL: .* run 1 of 2; load /m, result.stdout + result.stderr);
  assert.match(result.stdout, /boom/, 'the output of the failed run is missing');
});

test('make node-repeat rejects a name pattern that runs no passed test, with the color of the reporter on or off', (t) => {
  const file = fixture(t, 'test("probe passes", () => {});');
  for (const color of ['3', '0']) {
    const result = spawnSync('make', ['node-repeat', `FILE=${file}`, 'NAME=missing probe', 'COUNT=2'], {
      cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, FORCE_COLOR: color },
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /no test .* matched/, `FORCE_COLOR=${color}: ${result.stdout}${result.stderr}`);
  }
});

test('make node-repeat counts passing runs when the reporter writes colors', (t) => {
  const file = fixture(t, 'test("probe passes", () => {});');
  const result = spawnSync('make', ['node-repeat', `FILE=${file}`, 'NAME=probe passes', 'COUNT=2'], {
    cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, FORCE_COLOR: '3' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /2 of 2 runs pass/);
});

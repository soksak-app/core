import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeTestEvidence, readNodeTestEvidence, withNodeTestReporters, NODE_TEST_REPORTERS, testExecutionErrors } from '../node-test-evidence.mjs';
import { EVENT_PREFIX } from '../test-event-reporter.mjs';

const summary = (file, counts = {}) => ({ type: 'test:summary', file, success: true,
  counts: { tests: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0, todo: 0, ...counts } });

test('file-owned evidence aggregates every declared file and rejects a missing file despite a passing wrapper', { timeout: 10_000 }, () => {
  const evidence = createNodeTestEvidence(['/first.test.mjs', '/second.test.mjs']);
  evidence.track(summary('/first.test.mjs'));
  evidence.track(summary(undefined, { tests: 2, passed: 2 }));
  assert.match(evidence.result().errors.join('; '), /missing or incomplete test evidence for \/second.test.mjs/);
  evidence.track(summary('/second.test.mjs', { tests: 2, passed: 2 }));
  assert.deepEqual(evidence.result(), { actual: { tests: 3, failed: 0, skipped: 0, cancelled: 0, todo: 0 }, errors: [] });
});

test('a skipped or todo suite remains incomplete evidence when Node test totals omit the suite', { timeout: 10_000 }, () => {
  for (const flag of ['skip', 'todo']) {
    const evidence = createNodeTestEvidence(['/case.test.mjs']);
    evidence.track(summary('/case.test.mjs'));
    evidence.track({ type: 'test:complete', name: 'required suite', [flag]: true });
    const result = evidence.result();
    assert.equal(result.actual[flag === 'skip' ? 'skipped' : 'todo'], 1);
    assert.match(result.errors.join('; '), /incomplete test evidence: .*required suite/);
  }
});

test('malformed summaries and missing declared Node files cannot be accepted', { timeout: 10_000 }, () => {
  const evidence = createNodeTestEvidence(['/case.test.mjs']);
  evidence.track(summary('/case.test.mjs', { passed: undefined }));
  assert.match(evidence.result().errors.join('; '), /missing or incomplete test evidence/);
  assert.match(readNodeTestEvidence(`${EVENT_PREFIX}${JSON.stringify(summary('/case.test.mjs'))}\n`).errors.join('; '), /missing declared Node test files/);
  assert.throws(() => readNodeTestEvidence(`${EVENT_PREFIX}{broken\n`, ['/case.test.mjs']), SyntaxError);
});

test('the shared acceptance rule rejects unexecuted and incomplete cases', { timeout: 10_000 }, () => {
  assert.deepEqual(testExecutionErrors({ tests: 1, failed: 0, skipped: 0, cancelled: 0, todo: 0 }), []);
  for (const field of ['failed', 'skipped', 'cancelled', 'todo']) {
    assert.equal(testExecutionErrors({ tests: 1, failed: 0, skipped: 0, cancelled: 0, todo: 0, [field]: 1 }).length, 1);
  }
  assert.deepEqual(testExecutionErrors({ tests: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0 }), ['zero tests reported']);
});

test('reporter installation preserves selection flags and replaces both reporter argument forms', { timeout: 10_000 }, () => {
  assert.deepEqual(withNodeTestReporters(['--test', '--test-reporter', 'tap', '--test-reporter-destination=stdout', '--test-name-pattern=selected', '/case.test.mjs']),
    ['--test', ...NODE_TEST_REPORTERS, '--test-name-pattern=selected', '/case.test.mjs']);
});

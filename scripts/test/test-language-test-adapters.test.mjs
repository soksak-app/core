import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TIMEOUT_MS, discoverLanguageCases, parseLanguageResult, runLanguageCases } from '../language-test-adapters.mjs';

const command = (source) => ({ command: process.execPath, args: ['-e', source] });

test('discovers all supported language cases with explicit default limits', () => {
  const cases = discoverLanguageCases({ cases: Object.entries(DEFAULT_TIMEOUT_MS).filter(([language]) => language !== 'application').map(([language]) => ({ id: language, language, ...command('process.exit(0)') })) });
  assert.deepEqual(cases.map(({ language, timeoutMs }) => [language, timeoutMs]), [
    ['js-ts', 10_000], ['rust', 30_000], ['go', 30_000], ['objective-c', 30_000],
  ]);
});

test('rejects empty, duplicate, unsupported, skipped, and invalid cases', () => {
  assert.throws(() => discoverLanguageCases({ cases: [] }), /at least one/);
  assert.throws(() => discoverLanguageCases({ cases: [{ id: 'x', language: 'js-ts', ...command(''), expectedStatus: 'skip' }] }), /expectedStatus/);
  assert.throws(() => discoverLanguageCases({ cases: [{ id: 'x', language: 'js-ts', ...command('process.exit(0)') }, { id: 'x', language: 'js-ts', ...command('process.exit(0)') }] }), /duplicate/);
  assert.throws(() => discoverLanguageCases({ cases: [{ id: 'x', language: 'python', ...command('process.exit(0)') }] }), /unsupported/);
});

test('parses each language result and rejects zero, skipped, and crashed outcomes', async () => {
  assert.equal(parseLanguageResult('js-ts', 'ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ skipped 0\nℹ todo 0\nℹ cancelled 0', '').tests, 2);
  assert.deepEqual(parseLanguageResult('rust', 'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;', ''), { tests: 2, failed: 0, skipped: 0, cancelled: 0, todo: 0 });
  assert.equal(parseLanguageResult('go', '{"Action":"pass","Test":"TestOne"}\n{"Action":"pass","Test":"TestTwo"}', '').tests, 2);
  assert.equal(parseLanguageResult('go', '{"Action":"skip","Package":"example/no-tests","Output":"[no test files]\\n"}', '').skipped, 1);
  assert.equal(parseLanguageResult('objective-c', 'PASS: first\nPASS: second', '').tests, 2);

  const cases = discoverLanguageCases({ cases: [
    { id: 'pass', language: 'js-ts', ...command("console.log('ℹ tests 1\\nℹ pass 1\\nℹ fail 0\\nℹ skipped 0\\nℹ todo 0\\nℹ cancelled 0')") },
    { id: 'zero', language: 'rust', ...command('process.exit(0)') },
    { id: 'crash', language: 'go', ...command('process.kill(process.pid, \'SIGABRT\')') },
  ] });
  const result = await runLanguageCases(cases);
  assert.equal(result.status, 'fail');
  assert.equal(result.cases.find((item) => item.id === 'pass').status, 'pass');
  assert.match(result.cases.find((item) => item.id === 'zero').errors.join(' '), /zero tests/);
  assert.match(result.cases.find((item) => item.id === 'crash').errors.join(' '), /crashed/);
});

test('reports expected and actual test counts without hiding mismatch', async () => {
  const cases = discoverLanguageCases({ cases: [{ id: 'count', language: 'js-ts', expectedTests: 2, ...command("console.log('ℹ tests 1\\nℹ pass 1\\nℹ fail 0\\nℹ skipped 0\\nℹ todo 0\\nℹ cancelled 0')") }] });
  const result = await runLanguageCases(cases);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.cases[0].expected, { status: 'pass', tests: 2 });
  assert.match(result.cases[0].errors.join(' '), /expected 2 tests, observed 1/);
});

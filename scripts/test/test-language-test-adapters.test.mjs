import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUPPORTED_LANGUAGES, discoverLanguageCases, parseLanguageResult, runLanguageCases } from '../language-test-adapters.mjs';

const command = (source) => ({ command: process.execPath, args: ['-e', source], timeoutMs: 30_000 });

async function nodeCase(t, source, flags = []) {
  const directory = await mkdtemp(join(tmpdir(), 'soksak-language-node-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'probe.test.mjs');
  await writeFile(file, `import { test, describe, it } from 'node:test';\n${source}\n`);
  return { id: 'node-evidence', language: 'js-ts', command: '/usr/bin/env', args: ['-u', 'NODE_TEST_CONTEXT', process.execPath, '--test', '--test-reporter=tap', ...flags, file], timeoutMs: 30_000, testFiles: [file] };
}

for (const [label, source] of [
  ['empty file', ''],
  ['exit before registration', 'process.exit(0);'],
  ['skipped suite beside a passing case', 'test("required", () => {}); describe.skip("omitted suite", () => { it("case", () => {}); });'],
  ['todo case', 'test.todo("required");'],
  ['failed case', 'test("required", () => { throw new Error("required failure"); });'],
  ['cancelled case', 'test("required", { signal: AbortSignal.abort(new Error("cancelled fixture")) }, () => {});'],
]) {
  test(`the Node adapter rejects ${label}`, { timeout: 30_000 }, async (t) => {
    const result = await runLanguageCases(discoverLanguageCases({ cases: [await nodeCase(t, source)] }));
    assert.equal(result.status, 'fail', JSON.stringify(result));
  });
}

test('the Node adapter accepts nested selected cases and rejects an empty selection', { timeout: 30_000 }, async (t) => {
  const source = 'describe("selected suite", () => { it("selected case", () => {}); }); test("other", () => { throw new Error("unselected"); });';
  const passing = await nodeCase(t, source, ['--test-name-pattern=selected']);
  const result = await runLanguageCases(discoverLanguageCases({ cases: [passing] }));
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(result.cases[0].actual.tests, 1);
  const empty = await nodeCase(t, source, ['--test-name-pattern=missing']);
  const missing = await runLanguageCases(discoverLanguageCases({ cases: [empty] }));
  assert.equal(missing.status, 'fail', JSON.stringify(missing));
  assert.match(missing.cases[0].errors.join('; '), /zero tests/);
});

test('the Node adapter refuses an empty selected file beside a passing file', { timeout: 30_000 }, async (t) => {
  const passing = await nodeCase(t, 'test("required", () => {});');
  const empty = await nodeCase(t, '');
  passing.args.push(empty.testFiles[0]);
  passing.testFiles.push(empty.testFiles[0]);
  const result = await runLanguageCases(discoverLanguageCases({ cases: [passing] }));
  assert.equal(result.status, 'fail', JSON.stringify(result));
  assert.match(result.cases[0].errors.join('; '), /missing or incomplete test evidence/);
});

test('the Rust adapter aggregates every target including ignored or failed earlier targets', () => {
  const output = 'test result: FAILED. 2 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out;\n'
    + 'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;\n'
    + 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;';
  assert.deepEqual(parseLanguageResult('rust', output, ''), { tests: 6, failed: 1, skipped: 1, cancelled: 0, todo: 0 });
});

test('discovers all supported language cases, each with its own explicit limit', () => {
  const cases = discoverLanguageCases({ cases: SUPPORTED_LANGUAGES.filter((language) => language !== 'application').map((language) => ({ id: language, language, ...command('process.exit(0)') })) });
  assert.deepEqual(cases.map(({ language, timeoutMs }) => [language, timeoutMs]), [
    ['js-ts', 30_000], ['rust', 30_000], ['go', 30_000], ['objective-c', 30_000], ['shell', 30_000],
  ]);
});

test('refuses a case without its own limit and names the case', () => {
  assert.throws(() => discoverLanguageCases({ cases: [{ id: 'no-limit', language: 'rust', command: process.execPath, args: ['-e', 'process.exit(0)'] }] }), /case no-limit has no timeoutMs/);
});

test('rejects empty, duplicate, unsupported, skipped, and invalid cases', () => {
  assert.throws(() => discoverLanguageCases({ cases: [] }), /at least one/);
  assert.throws(() => discoverLanguageCases({ cases: [{ id: 'x', language: 'js-ts', ...command(''), expectedStatus: 'skip' }] }), /expectedStatus/);
  assert.throws(() => discoverLanguageCases({ cases: [{ id: 'x', language: 'js-ts', ...command('process.exit(0)') }, { id: 'x', language: 'js-ts', ...command('process.exit(0)') }] }), /duplicate/);
  assert.throws(() => discoverLanguageCases({ cases: [{ id: 'x', language: 'python', ...command('process.exit(0)') }] }), /unsupported/);
});

test('parses each language result and rejects zero, skipped, and crashed outcomes', async () => {
  assert.equal(parseLanguageResult('js-ts', 'ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ skipped 0\nℹ todo 0\nℹ cancelled 0', '').tests, 0, 'wrapper totals do not prove file-owned execution');
  assert.deepEqual(parseLanguageResult('rust', 'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;', ''), { tests: 2, failed: 0, skipped: 0, cancelled: 0, todo: 0 });
  assert.equal(parseLanguageResult('go', '{"Action":"pass","Test":"TestOne"}\n{"Action":"pass","Test":"TestTwo"}', '').tests, 2);
  assert.equal(parseLanguageResult('go', '{"Action":"skip","Package":"example/no-tests","Output":"[no test files]\\n"}', '').skipped, 1);
  assert.equal(parseLanguageResult('objective-c', 'PASS: first\nPASS: second', '').tests, 2);
  assert.deepEqual(parseLanguageResult('shell', 'PASS: first\nFAIL: second\nSKIP: third\nCANCEL: fourth\nTODO: fifth', ''), {
    tests: 2, failed: 1, skipped: 1, cancelled: 1, todo: 1,
  });
  assert.deepEqual(parseLanguageResult('shell', 'PASS: first\nFAIL:', ''), {
    tests: 2, failed: 1, skipped: 0, cancelled: 0, todo: 0,
  });

  const cases = discoverLanguageCases({ cases: [
    { id: 'pass', language: 'shell', ...command("console.log('PASS: required')") },
    { id: 'zero', language: 'rust', ...command('process.exit(0)') },
    { id: 'crash', language: 'go', ...command('process.kill(process.pid, \'SIGABRT\')') },
  ] });
  const result = await runLanguageCases(cases);
  assert.equal(result.status, 'fail');
  assert.equal(result.cases.find((item) => item.id === 'pass').status, 'pass');
  assert.match(result.cases.find((item) => item.id === 'zero').errors.join(' '), /zero tests/);
  assert.match(result.cases.find((item) => item.id === 'crash').errors.join(' '), /crashed/);

  const skipped = await runLanguageCases(discoverLanguageCases({ cases: [
    { id: 'mandatory-skip', language: 'rust', ...command("console.log('test result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out;')") },
  ] }));
  assert.equal(skipped.status, 'fail');
  assert.match(skipped.cases[0].errors.join(' '), /skipped/);
});

test('reports expected and actual test counts without hiding mismatch', async () => {
  const cases = discoverLanguageCases({ cases: [{ id: 'count', language: 'shell', expectedTests: 2, ...command("console.log('PASS: required')") }] });
  const result = await runLanguageCases(cases);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.cases[0].expected, { status: 'pass', tests: 2 });
  assert.match(result.cases[0].errors.join(' '), /expected 2 tests, observed 1/);
});

test('the node case counts its tests when the reporter writes colors', { timeout: 30_000 }, async () => {
  // The node:test execution context (NODE_TEST_CONTEXT) of this check is not passed to the child check.
  const saved = { color: process.env.FORCE_COLOR, context: process.env.NODE_TEST_CONTEXT };
  process.env.FORCE_COLOR = '3';
  delete process.env.NODE_TEST_CONTEXT;
  try {
    // A fixture of three tests: the count is the subject, so the check does not run the repository's own suites again.
    const fixture = 'scripts/test/fixtures/node-color-count.mjs';
    const cases = discoverLanguageCases({ cases: [{
      id: 'js-color-count', language: 'js-ts', command: 'node', args: ['--test', '--test-reporter=tap', fixture], timeoutMs: 30_000, expectedTests: 3,
      implementationFiles: [fixture], testFiles: [fixture], dependencyFiles: ['package.json'], buildFlags: ['node --test'],
    }] });
    const result = await runLanguageCases(cases);
    for (const item of result.cases) {
      assert.equal(item.status, 'pass', JSON.stringify(item));
      assert.equal(item.actual.tests, item.expected.tests, JSON.stringify(item.actual));
    }
  } finally {
    if (saved.color === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = saved.color;
    if (saved.context !== undefined) process.env.NODE_TEST_CONTEXT = saved.context;
  }
});

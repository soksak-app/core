import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUPPORTED_LANGUAGES, discoverLanguageCases, parseLanguageResult, runLanguageCases } from '../language-test-adapters.mjs';

const command = (source) => ({ command: process.execPath, args: ['-e', source], timeoutMs: 30_000 });

test('the language adapter refuses to attribute a pass to inputs changed by its command', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'soksak-language-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'evidence@example.invalid');
  git('config', 'user.name', 'evidence');
  await writeFile(join(root, 'source.txt'), 'tested content');
  await writeFile(join(root, 'case.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('source.txt', 'utf8'), 'tested content'); require('node:fs').writeFileSync('source.txt', 'untested content'); console.log('PASS: input assertion');\n");
  await writeFile(join(root, 'package.json'), '{}');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  const cases = discoverLanguageCases({ cases: [{ id: 'input-change', language: 'shell', command: process.execPath,
    args: ['case.cjs'], cwd: root, timeoutMs: 10000, implementationFiles: [join(root, 'source.txt')],
    testFiles: [join(root, 'case.cjs')], dependencyFiles: [join(root, 'package.json')], buildFlags: [] }] });
  const result = await runLanguageCases(cases, { evidence: true, root });
  assert.equal(result.status, 'fail', 'a successful assertion against old content cannot validate new content');
  assert.equal(result.cases[0].evidence.commandResult.status, 'pass');
  assert.equal(result.cases[0].evidence.implementation.files[0].sha256, createHash('sha256').update('tested content').digest('hex'));
  assert.match(result.cases[0].errors.join('\n'), /inputs changed during execution/);
});

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

const goSupportEvents = [
  { Action: 'start', Package: 'fixture/support' },
  { Action: 'output', Package: 'fixture/support', Output: '?   \tfixture/support\t[no test files]\n' },
  { Action: 'skip', Package: 'fixture/support', Elapsed: 0 },
];
const goPassingEvents = [
  { Action: 'run', Package: 'fixture', Test: 'TestSelected' },
  { Action: 'pass', Package: 'fixture', Test: 'TestSelected', Elapsed: 0 },
  { Action: 'output', Package: 'fixture', Output: 'PASS\n' },
  { Action: 'pass', Package: 'fixture', Elapsed: 0.1 },
];

test('a case whose build reports an object newer than the link fails with the object and both versions', { timeout: 30_000 }, async () => {
  const warning = "ld: warning: object file (/target/ring/libring_core.a(curve25519.o)) was built for newer 'macOS' version (27.0) than being linked (11.0)";
  const cases = discoverLanguageCases({ cases: [{ id: 'linked', language: 'go', ...command("console.log(JSON.stringify({ Action: 'pass', Test: 'TestLinked' }))"),
    build: { command: process.execPath, args: ['-e', `console.error(${JSON.stringify(warning)})`], timeoutMs: 30_000 } }] });
  // The command forwards the build output; the test holds it, because the warning is the fixture of this case and not a link of the suite.
  const forwarded = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    forwarded.push(String(chunk));
    const done = rest.find((item) => typeof item === 'function');
    if (done) done();
    return true;
  };
  let result;
  try {
    result = await runLanguageCases(cases);
  } finally {
    process.stderr.write = write;
  }
  assert.ok(forwarded.join('').includes(warning), `the build output was not forwarded: ${JSON.stringify(forwarded)}`);
  assert.equal(result.status, 'fail', JSON.stringify(result));
  assert.equal(result.cases[0].build.status, 'fail');
  assert.ok(result.cases[0].errors.includes('ld built /target/ring/libring_core.a(curve25519.o) for macOS 27.0, newer than the macOS 11.0 of the link'), JSON.stringify(result.cases[0].errors));
});

test('the Go adapter counts a failed named test as executed', { timeout: 10_000 }, () => {
  const output = [
    { Action: 'run', Package: 'fixture', Test: 'TestRequired' },
    { Action: 'output', Package: 'fixture', Test: 'TestRequired', Output: '    required_test.go:5: actual differs from expected\n' },
    { Action: 'fail', Package: 'fixture', Test: 'TestRequired', Elapsed: 0 },
    { Action: 'fail', Package: 'fixture', Elapsed: 0.1 },
  ].map((event) => JSON.stringify(event)).join('\n');
  assert.deepEqual(parseLanguageResult('go', output, ''), { tests: 1, failed: 1, skipped: 0, cancelled: 0, todo: 0 });
});

for (const [name, events, expected, status] of [
  ['the Go adapter accepts a passing test beside a support package without tests', [...goSupportEvents, ...goPassingEvents], { tests: 1, skipped: 0 }, 'pass'],
  ['the Go adapter rejects a named skipped test beside a passing test', [...goPassingEvents,
    { Action: 'run', Package: 'fixture', Test: 'TestRequired' },
    { Action: 'output', Package: 'fixture', Test: 'TestRequired', Output: '    required_test.go:5: unavailable\n' },
    { Action: 'skip', Package: 'fixture', Test: 'TestRequired', Elapsed: 0 }], { tests: 1, skipped: 1 }, 'fail'],
  ['the Go adapter rejects a selection containing only support packages without tests', goSupportEvents, { tests: 0, skipped: 0 }, 'fail'],
  ['the Go adapter rejects a successful package with no selected test', [
    { Action: 'output', Package: 'fixture', Output: 'testing: warning: no tests to run\n' },
    { Action: 'pass', Package: 'fixture', Elapsed: 0.1 }], { tests: 0, skipped: 0 }, 'fail'],
]) {
  test(name, { timeout: 10_000 }, async () => {
    // Go emits package output and package skip as separate events. Only an event with Test names a test outcome.
    const output = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
    const parsed = parseLanguageResult('go', output, '');
    assert.equal(parsed.tests, expected.tests);
    assert.equal(parsed.skipped, expected.skipped);
    const cases = discoverLanguageCases({ cases: [{ id: 'go-selection', language: 'go',
      ...command(`process.stdout.write(${JSON.stringify(output)})`) }] });
    const result = await runLanguageCases(cases);
    assert.equal(result.status, status, JSON.stringify(result));
    if (expected.tests === 0) assert.match(result.cases[0].errors.join('; '), /zero tests reported/);
    if (expected.skipped > 0) assert.match(result.cases[0].errors.join('; '), /1 test\(s\) skipped/);
  });
}

/**
 * A fake cargo in a new folder: the first run compiles for compileMs and leaves its output, a later run finds the output and
 * compiles nothing, and a run without --no-run reports one passed test. It models a cold build that is longer than the limit
 * of the test run.
 */
async function fakeCargo(t, compileMs) {
  const directory = await mkdtemp(join(tmpdir(), 'soksak-language-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'cargo.cjs');
  await writeFile(file, `const { existsSync, writeFileSync } = require('node:fs');
const output = ${JSON.stringify(join(directory, 'built'))};
if (!existsSync(output)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${compileMs});
  writeFileSync(output, '');
}
if (!process.argv.includes('--no-run')) console.log('test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;');
`);
  return { file, output: join(directory, 'built') };
}

test('a case builds before its test runs, so the limit of the case measures only the test', { timeout: 30_000 }, async (t) => {
  const cargo = await fakeCargo(t, 3000);
  const events = [];
  const cases = discoverLanguageCases({ cases: [{ id: 'cold-build', language: 'rust', command: process.execPath, args: [cargo.file, 'test'],
    timeoutMs: 2000, expectedTests: 1, build: { command: process.execPath, args: [cargo.file, 'test', '--no-run'], timeoutMs: 20_000 } }] });
  const result = await runLanguageCases(cases, { onEvent: (event) => events.push(event) });
  assert.equal(result.status, 'pass', JSON.stringify(result.cases[0].errors));
  // The build waits 3000 ms and the limit of the test is 2000 ms, so a limit that included the build would end the case as a timeout.
  assert.equal(result.cases[0].build.status, 'pass');
  assert.deepEqual(events.filter((event) => event.type !== 'progress').map(({ type, phase }) => [phase, type]),
    [['build', 'start'], ['build', 'pass'], ['test', 'start'], ['test', 'pass']]);
});

for (const [label, build, status, error] of [
  ['fails', `console.error('error[E0425]: cannot find value'); process.exit(101)`, 'fail', 'build status fail'],
  ['passes its own limit', 'setInterval(() => {}, 1000)', 'timeout', 'build status timeout'],
]) {
  test(`a case whose build ${label} reports the build and runs no test`, { timeout: 30_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'soksak-language-unbuilt-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const ran = join(directory, 'ran');
    const cases = discoverLanguageCases({ cases: [{ id: 'unbuilt', language: 'rust', expectedTests: 1,
      ...command(`require('node:fs').writeFileSync(${JSON.stringify(ran)}, ''); console.log('test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;')`),
      build: { command: process.execPath, args: ['-e', build], timeoutMs: 1000 } }] });
    const result = await runLanguageCases(cases);
    assert.equal(result.status, 'fail');
    assert.equal(result.cases[0].build.status, status);
    assert.equal(result.cases[0].actual.status, 'not-run');
    assert.deepEqual(result.cases[0].errors, [error, 'the build failed, so no test ran']);
    assert.equal(existsSync(ran), false, 'the test command ran after a failed build');
  });
}

test('refuses a build without its own limit and names the case', () => {
  assert.throws(() => discoverLanguageCases({ cases: [{ id: 'no-build-limit', language: 'rust', ...command('process.exit(0)'),
    build: { command: process.execPath, args: [] } }] }), /case no-build-limit\.build has no timeoutMs/);
  assert.throws(() => discoverLanguageCases({ cases: [{ id: 'no-build-command', language: 'rust', ...command('process.exit(0)'),
    build: { args: [], timeoutMs: 1000 } }] }), /case no-build-command\.build\.command must be a non-empty string/);
});

for (const phase of ['test', 'build']) {
  test(`a case whose ${phase} prints a process warning of node fails with the warning`, { timeout: 30_000 }, async () => {
    const warning = '(node:4242) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 end listeners added to [TestsStream].';
    const print = `console.error(${JSON.stringify(warning)})`;
    const cases = discoverLanguageCases({ cases: [{ id: 'warned', language: 'shell',
      ...command(`${phase === 'test' ? print : ''}; console.log('PASS: warned case')`),
      ...(phase === 'build' ? { build: { command: process.execPath, args: ['-e', print], timeoutMs: 30_000 } } : {}) }] });
    const result = await runLanguageCases(cases);
    assert.equal(result.status, 'fail', JSON.stringify(result.cases[0]));
    assert.ok(result.cases[0].errors.includes('node printed MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 end listeners added to [TestsStream].'),
      JSON.stringify(result.cases[0].errors));
  });
}

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
    // A signal ends the case, whichever it is. SIGKILL leaves no crash report on the machine, as SIGABRT does at each run.
    { id: 'crash', language: 'go', ...command('process.kill(process.pid, \'SIGKILL\')') },
  ] });
  const result = await runLanguageCases(cases);
  assert.equal(result.status, 'fail');
  assert.equal(result.cases.find((item) => item.id === 'pass').status, 'pass');
  assert.match(result.cases.find((item) => item.id === 'zero').errors.join(' '), /zero tests/);
  assert.match(result.cases.find((item) => item.id === 'crash').errors.join(' '), /process crashed with SIGKILL/);

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

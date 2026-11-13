import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cargoCommand } from '@soksak/window-check/cargo.mjs';
import { SUPPORTED_LANGUAGES, discoverLanguageCases, parseLanguageResult, runLanguageCases } from '../language-test-adapters.mjs';

// The fixtures of the language adapter tests: the emitter program, its output files, the node test files and the cold-build crate.
const fixtures = join(import.meta.dirname, 'fixtures', 'language-adapters');
const emit = join(fixtures, 'emit.mjs');
const output = (name) => join(fixtures, 'output', name);

/** A case program: the emitter of the fixtures, run with the options `args` (see fixtures/language-adapters/emit.mjs). */
const program = (...args) => ({ command: process.execPath, args: [emit, ...args], timeoutMs: 30_000 });

/** A data file of the test in a folder of its own, removed when the test ends. */
async function dataFile(t, name, text) {
  const directory = await mkdtemp(join(tmpdir(), 'soksak-language-data-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, name);
  await writeFile(file, text);
  return file;
}

test('the language adapter refuses to attribute a pass to inputs changed by its command', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'soksak-language-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'evidence@example.invalid');
  git('config', 'user.name', 'evidence');
  await writeFile(join(root, 'source.txt'), 'tested content');
  await writeFile(join(root, 'package.json'), '{}');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  const cases = discoverLanguageCases({ cases: [{ id: 'input-change', language: 'shell', command: process.execPath,
    args: [join(fixtures, 'input-change.cjs')], cwd: root, timeoutMs: 10000, implementationFiles: [join(root, 'source.txt')],
    testFiles: [join(fixtures, 'input-change.cjs')], dependencyFiles: [join(root, 'package.json')], buildFlags: [] }] });
  const result = await runLanguageCases(cases, { evidence: true, root });
  assert.equal(result.status, 'fail', 'a successful assertion against old content cannot validate new content');
  assert.equal(result.cases[0].evidence.commandResult.status, 'pass');
  assert.equal(result.cases[0].evidence.implementation.files[0].sha256, createHash('sha256').update('tested content').digest('hex'));
  assert.match(result.cases[0].errors.join('\n'), /inputs changed during execution/);
});

/** A case of the Node adapter that runs the test file `name` of the node fixtures with the flags. */
function nodeCase(name, flags = []) {
  const file = join(fixtures, 'node', name);
  return { id: 'node-evidence', language: 'js-ts', command: '/usr/bin/env', args: ['-u', 'NODE_TEST_CONTEXT', process.execPath, '--test', '--test-reporter=tap', ...flags, file], timeoutMs: 30_000, testFiles: [file] };
}

for (const [label, name] of [
  ['empty file', 'empty.mjs'],
  ['exit before registration', 'exit-before-registration.mjs'],
  ['skipped suite beside a passing case', 'skipped-suite.mjs'],
  ['todo case', 'todo.mjs'],
  ['failed case', 'failed.mjs'],
  ['cancelled case', 'cancelled.mjs'],
]) {
  test(`the Node adapter rejects ${label}`, { timeout: 30_000 }, async () => {
    const result = await runLanguageCases(discoverLanguageCases({ cases: [nodeCase(name)] }));
    assert.equal(result.status, 'fail', JSON.stringify(result));
  });
}

test('the Node adapter accepts nested selected cases and rejects an empty selection', { timeout: 30_000 }, async () => {
  const passing = nodeCase('selected.mjs', ['--test-name-pattern=selected']);
  const result = await runLanguageCases(discoverLanguageCases({ cases: [passing] }));
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(result.cases[0].actual.tests, 1);
  const empty = nodeCase('selected.mjs', ['--test-name-pattern=missing']);
  const missing = await runLanguageCases(discoverLanguageCases({ cases: [empty] }));
  assert.equal(missing.status, 'fail', JSON.stringify(missing));
  assert.match(missing.cases[0].errors.join('; '), /zero tests/);
});

test('the Node adapter refuses an empty selected file beside a passing file', { timeout: 30_000 }, async () => {
  const passing = nodeCase('passing.mjs');
  const empty = nodeCase('empty.mjs');
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
  const cases = discoverLanguageCases({ cases: [{ id: 'linked', language: 'go', ...program('--stdout', output('go-linked-pass.txt')),
    build: { command: process.execPath, args: [emit, '--stderr', output('linked-warning.txt')], timeoutMs: 30_000 } }] });
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
  test(name, { timeout: 10_000 }, async (t) => {
    // Go emits package output and package skip as separate events. Only an event with Test names a test outcome.
    const text = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
    const parsed = parseLanguageResult('go', text, '');
    assert.equal(parsed.tests, expected.tests);
    assert.equal(parsed.skipped, expected.skipped);
    const file = await dataFile(t, 'events.jsonl', text);
    const cases = discoverLanguageCases({ cases: [{ id: 'go-selection', language: 'go', ...program('--stdout', file) }] });
    const result = await runLanguageCases(cases);
    assert.equal(result.status, status, JSON.stringify(result));
    if (expected.tests === 0) assert.match(result.cases[0].errors.join('; '), /zero tests reported/);
    if (expected.skipped > 0) assert.match(result.cases[0].errors.join('; '), /1 test\(s\) skipped/);
  });
}

test('a case builds before its test runs, so the limit of the case measures only the test', { timeout: 300_000 }, async (t) => {
  // The build script of the cold-build crate sleeps 3 seconds, so a cold build of it is longer than the limit of the test (2 seconds).
  const target = await mkdtemp(join(tmpdir(), 'soksak-language-cold-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const previous = process.env.CARGO_TARGET_DIR;
  process.env.CARGO_TARGET_DIR = target;
  t.after(() => {
    if (previous === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = previous;
  });
  const crate = join(fixtures, 'cold-build');
  const cargo = cargoCommand();
  const events = [];
  const cases = discoverLanguageCases({ cases: [{ id: 'cold-build', language: 'rust', command: cargo, args: ['test', '--locked'], cwd: crate,
    timeoutMs: 2000, expectedTests: 1, build: { command: cargo, args: ['test', '--locked', '--no-run'], cwd: crate, timeoutMs: 120_000 } }] });
  const result = await runLanguageCases(cases, { onEvent: (event) => events.push(event) });
  assert.equal(result.status, 'pass', JSON.stringify(result.cases[0].errors));
  // The build takes longer than the limit of the test, so a limit that included the build would end the case as a timeout.
  assert.equal(result.cases[0].build.status, 'pass');
  assert.deepEqual(events.filter((event) => event.type !== 'progress').map(({ type, phase }) => [phase, type]),
    [['build', 'start'], ['build', 'pass'], ['test', 'start'], ['test', 'pass']]);
});

for (const [label, buildOptions, status, error] of [
  ['fails', ['--stderr', output('compile-error.txt'), '--exit', '101'], 'fail', 'build status fail'],
  ['passes its own limit', ['--hang'], 'timeout', 'build status timeout'],
]) {
  test(`a case whose build ${label} reports the build and runs no test`, { timeout: 30_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'soksak-language-unbuilt-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const ran = join(directory, 'ran');
    const cases = discoverLanguageCases({ cases: [{ id: 'unbuilt', language: 'rust', expectedTests: 1,
      ...program('--touch', ran, '--stdout', output('rust-ok.txt')),
      build: { command: process.execPath, args: [emit, ...buildOptions], timeoutMs: 1000 } }] });
    const result = await runLanguageCases(cases);
    assert.equal(result.status, 'fail');
    assert.equal(result.cases[0].build.status, status);
    assert.equal(result.cases[0].actual.status, 'not-run');
    assert.deepEqual(result.cases[0].errors, [error, 'the build failed, so no test ran']);
    assert.equal(existsSync(ran), false, 'the test command ran after a failed build');
  });
}

test('refuses a build without its own limit and names the case', () => {
  assert.throws(() => discoverLanguageCases({ cases: [{ id: 'no-build-limit', language: 'rust', ...program(),
    build: { command: process.execPath, args: [] } }] }), /case no-build-limit\.build has no timeoutMs/);
  assert.throws(() => discoverLanguageCases({ cases: [{ id: 'no-build-command', language: 'rust', ...program(),
    build: { args: [], timeoutMs: 1000 } }] }), /case no-build-command\.build\.command must be a non-empty string/);
});

for (const phase of ['test', 'build']) {
  test(`a case whose ${phase} prints a process warning of node fails with the warning`, { timeout: 30_000 }, async () => {
    const cases = discoverLanguageCases({ cases: [{ id: 'warned', language: 'shell',
      ...program('--stdout', output('pass-warned.txt'), ...(phase === 'test' ? ['--stderr', output('node-warning.txt')] : [])),
      ...(phase === 'build' ? { build: { command: process.execPath, args: [emit, '--stderr', output('node-warning.txt')], timeoutMs: 30_000 } } : {}) }] });
    const result = await runLanguageCases(cases);
    assert.equal(result.status, 'fail', JSON.stringify(result.cases[0]));
    assert.ok(result.cases[0].errors.includes('node printed MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 end listeners added to [TestsStream].'),
      JSON.stringify(result.cases[0].errors));
  });
}

test('discovers all supported language cases, each with its own explicit limit', () => {
  const cases = discoverLanguageCases({ cases: SUPPORTED_LANGUAGES.filter((language) => language !== 'application').map((language) => ({ id: language, language, ...program() })) });
  assert.deepEqual(cases.map(({ language, timeoutMs }) => [language, timeoutMs]), [
    ['js-ts', 30_000], ['rust', 30_000], ['go', 30_000], ['objective-c', 30_000], ['shell', 30_000],
  ]);
});

test('refuses a case without its own limit and names the case', () => {
  assert.throws(() => discoverLanguageCases({ cases: [{ id: 'no-limit', language: 'rust', command: process.execPath, args: [emit] }] }), /case no-limit has no timeoutMs/);
});

test('rejects empty, duplicate, unsupported, skipped, and invalid cases', () => {
  assert.throws(() => discoverLanguageCases({ cases: [] }), /at least one/);
  assert.throws(() => discoverLanguageCases({ cases: [{ id: 'x', language: 'js-ts', ...program(), expectedStatus: 'skip' }] }), /expectedStatus/);
  assert.throws(() => discoverLanguageCases({ cases: [{ id: 'x', language: 'js-ts', ...program() }, { id: 'x', language: 'js-ts', ...program() }] }), /duplicate/);
  assert.throws(() => discoverLanguageCases({ cases: [{ id: 'x', language: 'python', ...program() }] }), /unsupported/);
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
    { id: 'pass', language: 'shell', ...program('--stdout', output('pass-required.txt')) },
    { id: 'zero', language: 'rust', ...program() },
    // A signal ends the case, whichever it is. SIGKILL leaves no crash report on the machine, as SIGABRT does at each run.
    { id: 'crash', language: 'go', ...program('--signal', 'SIGKILL') },
  ] });
  const result = await runLanguageCases(cases);
  assert.equal(result.status, 'fail');
  assert.equal(result.cases.find((item) => item.id === 'pass').status, 'pass');
  assert.match(result.cases.find((item) => item.id === 'zero').errors.join(' '), /zero tests/);
  assert.match(result.cases.find((item) => item.id === 'crash').errors.join(' '), /process crashed with SIGKILL/);

  const skipped = await runLanguageCases(discoverLanguageCases({ cases: [
    { id: 'mandatory-skip', language: 'rust', ...program('--stdout', output('rust-ignored.txt')) },
  ] }));
  assert.equal(skipped.status, 'fail');
  assert.match(skipped.cases[0].errors.join(' '), /skipped/);
});

test('reports expected and actual test counts without hiding mismatch', async () => {
  const cases = discoverLanguageCases({ cases: [{ id: 'count', language: 'shell', expectedTests: 2, ...program('--stdout', output('pass-required.txt')) }] });
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

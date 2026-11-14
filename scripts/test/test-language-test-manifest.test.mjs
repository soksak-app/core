import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SUPPORTED_LANGUAGES, discoverLanguageCases } from '../language-test-adapters.mjs';
import { auditExecutableLanguageCoverage, auditLanguageCaseCounts, declaredLanguageCaseTests, repositoryFiles } from '../check-tests.mjs';

test('the committed language manifest declares one non-empty case for every supported language', async () => {
  const manifest = JSON.parse(await readFile(new URL('../language-test-cases.json', import.meta.url), 'utf8'));
  const cases = discoverLanguageCases(manifest);
  assert.deepEqual(cases.map(({ language }) => language).sort(), SUPPORTED_LANGUAGES.filter((language) => language !== 'application').sort());
  assert.ok(cases.every(({ command, args }) => command && Array.isArray(args)));
});

test('the language manifest covers every executable implementation language in the repository', async () => {
  const manifest = JSON.parse(await readFile(new URL('../language-test-cases.json', import.meta.url), 'utf8'));
  const cases = discoverLanguageCases(manifest);
  assert.deepEqual(auditExecutableLanguageCoverage(repositoryFiles(), cases.map(({ language }) => language)), [],
    'each executable source language must have an adapter case, and the manifest must not claim absent languages');
});

test('the expected tests of each committed language case are the tests that its test files declare', async () => {
  const manifest = JSON.parse(await readFile(new URL('../language-test-cases.json', import.meta.url), 'utf8'));
  const root = new URL('../../', import.meta.url);
  assert.deepEqual(auditLanguageCaseCounts(discoverLanguageCases(manifest), (file) => readFileSync(new URL(file, root), 'utf8')), []);
});

test('each committed case of a compiled language declares its build, so the limit of the case measures only the test', async () => {
  const manifest = JSON.parse(await readFile(new URL('../language-test-cases.json', import.meta.url), 'utf8'));
  const compiled = discoverLanguageCases(manifest).filter(({ language }) => ['rust', 'go', 'objective-c'].includes(language));
  assert.deepEqual(compiled.filter(({ build }) => build === undefined).map(({ id }) => id), []);
});

/** The declared tests of a case of `language` with `args` whose one test file is `text`. */
const declared = (language, text, args = []) => declaredLanguageCaseTests({ language, args, testFiles: ['case-file'] }, () => text);

test('a node:test file declares its top-level test() calls, and a nested or looped test leaves the count open', () => {
  assert.deepEqual(declared('js-ts', "test('a', () => {});\ntest('b', async (t) => {\n  assert.ok(true);\n});\n"), { tests: 2 });
  assert.match(declared('js-ts', "test('a', async (t) => {\n  await t.test('b', () => {});\n});\n").reason,
    /^case-file:2 declares a test that is not a top-level test\(\) call/);
  assert.match(declared('js-ts', "for (const name of names) {\n  test(name, () => {});\n}\n").reason, /^case-file:2 /);
  assert.match(declared('js-ts', "describe('group', () => {});\n").reason, /^case-file:1 /);
});

test('a Rust test file declares its #[test] functions without #[ignore], and a filter or a macro leaves the count open', () => {
  const text = '#[test]\nfn a() {}\n\n#[test]\n#[ignore]\nfn b() {}\n\n#[test]\n#[should_panic]\nfn c() {}\n';
  assert.deepEqual(declared('rust', text, ['test', '-p', 'pkg', '--test', 'case_test']), { tests: 2 });
  assert.deepEqual(declared('rust', text, ['test', '-p', 'pkg', '--test', 'case_test', 'a']), { reason: 'the case filters its tests by the name a' });
  assert.match(declared('rust', text, ['test', '--test', 'case_test', '--', '--exact', 'a']).reason, /arguments after --/);
  assert.match(declared('rust', `macro_rules! cases { () => {} }\n${text}`, ['test']).reason, /defines a macro/);
});

test('a Go test file declares the test functions that the -run pattern selects, and a subtest leaves the count open', () => {
  const text = 'func TestBuildA(t *testing.T) {\n\tcheck(t)\n}\n\nfunc TestBuildB(t *testing.T) {\n}\n\nfunc TestOther(t *testing.T) {\n}\n\n'
    + 'func helper(t *testing.T) {\n}\n';
  assert.deepEqual(declared('go', text, ['test', '-json', '-run', '^TestBuild', './tests']), { tests: 2 });
  assert.deepEqual(declared('go', text, ['test', '-json', './tests']), { tests: 3 });
  assert.match(declared('go', 'func TestBuildA(t *testing.T) {\n\tt.Run("x", func(t *testing.T) {})\n}\n', ['-run', '^TestBuild']).reason,
    /^case-file:1 TestBuildA runs subtests/);
  assert.match(declared('go', text, ['-run', '^TestBuild/x']).reason, /selects subtests/);
  assert.deepEqual(declared('go', text, ['tool', 'test2json', 'case.test', '-test.v=test2json', '-test.run', '^TestBuild']), { tests: 2 },
    'a case that runs its test binary selects its tests with -test.run');
});

test('an Objective-C or shell test declares a PASS line for each call of its writer and each line that writes one, and a loop leaves the count open', () => {
  const objc = 'static void check(BOOL ok, NSString *text) {\n    NSLog(@"PASS: %@", text);\n}\n\nint main(void) {\n    // wait for the view\n'
    + '    check(YES, @"a for (b)");\n    check(YES, @"c");\n    NSLog(@"PASS: d");\n}\n';
  assert.deepEqual(declared('objective-c', objc), { tests: 3 });
  assert.match(declared('objective-c', objc.replace('    check(YES, @"c");', '    for (int i = 0; i < 2; i++) check(YES, @"c");')).reason, /in a loop/);
  const shell = readFileSync(new URL('./fixtures/language-test-manifest/pass-counter.txt', import.meta.url), 'utf8');
  assert.deepEqual(declared('shell', shell), { tests: 2 });
  assert.match(declared('shell', `${shell}for tool in a b; do\n  printf 'PASS: %s\\n' "$tool"\ndone\n`).reason, /in a loop/);
});

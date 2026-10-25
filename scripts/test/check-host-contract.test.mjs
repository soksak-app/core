import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { auditDeclarations, auditHostContract, parseContractCases, groupResults, goTestSourceFilesForRun, parseDeclarations, uncoveredCases } from '../check-host-contract.mjs';

const SPEC = `# Hosts

## Contract cases

| Case | Behavior | Scope |
| --- | --- | --- |
| \`area.shared\` | Both hosts do this. | both |
| \`area.wails-only\` | Only Wails does this. | wailsv3 only: the framework owns it |

## Next
`;

const ONE_CASE = `# Hosts

## Contract cases

| Case | Behavior | Scope |
| --- | --- | --- |
| \`area.shared\` | Both hosts do this. | both |

## Next
`;

const GO = `package tests

// contract: area.shared
func TestShared(t *testing.T) {}

// contract: area.wails-only
func TestWailsOnly(t *testing.T) {}
`;

const RUST = `// contract: area.shared
#[test]
fn shared() {}
`;

const GO_OWNER = 'packages/host/wailsv3/tests';
/** A host of the static audit: the declarations of its test sources, without run results. */
const staticHost = (name, language, parsed) => ({ name, language, tests: parsed.tests, errors: parsed.errors });

/** The run map of one run: owner to the result of each test name of that owner. */
const owners = (owner, entries) => new Map([[owner, new Map(entries)]]);

function hosts({ go = GO, rust = RUST, goRuns, rustRuns } = {}) {
  const wails = parseDeclarations(go, 'go', `${GO_OWNER}/wails_test.go`);
  const tauri = parseDeclarations(rust, 'rust', 'tauri_test.rs');
  return [
    { name: 'wailsv3', language: 'go', ...wails, items: [], runs: goRuns ?? [owners(GO_OWNER, [['TestShared', 'pass'], ['TestWailsOnly', 'pass']])] },
    { name: 'tauriv2', language: 'rust', ...tauri, items: [], runs: rustRuns ?? [owners('.', [['shared', 'pass']])] },
  ];
}

test('host contract passes when each host runs a passing test for every case in its scope', () => {
  const { errors, covered } = auditHostContract(parseContractCases(SPEC), hosts());
  assert.deepEqual(errors, []);
  assert.deepEqual([...covered.get('wailsv3')].sort(), ['area.shared', 'area.wails-only']);
  assert.deepEqual([...covered.get('tauriv2')], ['area.shared']);
});

test('a host without a test for a shared case fails', () => {
  const { errors } = auditHostContract(parseContractCases(SPEC), hosts({ rust: '#[test]\nfn other() {}\n', rustRuns: [owners('.', [['other', 'pass']])] }));
  assert.ok(errors.includes('tauriv2 runs no passing test for contract case area.shared'), errors.join('\n'));
  assert.ok(errors.some((error) => error.includes('other declares no contract case')), errors.join('\n'));
});

test('a declared test that did not run, failed, or was skipped does not cover its case', () => {
  for (const [status, text] of [[undefined, 'did not run'], ['fail', 'reported fail'], ['skip', 'reported skip']]) {
    const runs = [owners('.', status ? [['shared', status]] : [['unrelated', 'pass']])];
    const { errors } = auditHostContract(parseContractCases(SPEC), hosts({ rustRuns: runs }));
    assert.ok(errors.some((error) => error.includes(`shared (area.shared) ${text}`)), `${status}: ${errors.join('\n')}`);
    assert.ok(errors.includes('tauriv2 runs no passing test for contract case area.shared'), errors.join('\n'));
  }
});

test('a host whose run reports zero tests fails', () => {
  const { errors } = auditHostContract(parseContractCases(SPEC), hosts({ rustRuns: [new Map(), new Map()] }));
  assert.ok(errors.includes('tauriv2: the test run reported zero tests'), errors.join('\n'));
});

test('a declaration of an undefined case or of a case outside the host scope fails', () => {
  const rust = '// contract: area.shared, area.missing\n#[test]\nfn shared() {}\n\n// contract: area.wails-only\n#[test]\nfn other() {}\n';
  const { errors } = auditHostContract(parseContractCases(SPEC), hosts({ rust, rustRuns: [owners('.', [['shared', 'pass'], ['other', 'pass']])] }));
  assert.ok(errors.some((error) => error.includes('declares undefined contract case area.missing')), errors.join('\n'));
  assert.ok(errors.some((error) => error.includes('declares area.wails-only, which the specification limits to wailsv3')), errors.join('\n'));
});

test('a declaration that is not attached to a test function is reported', () => {
  const go = '// contract: area.shared\nvar fixture = 1\n\n// contract: area.shared\nfunc TestShared(t *testing.T) {}\n';
  assert.deepEqual(parseDeclarations(go, 'go', 'a_test.go').errors, ['a_test.go:1 contract declaration is not attached to a test function']);
  const rust = '// contract: area.shared\nfn helper() {}\n';
  assert.deepEqual(parseDeclarations(rust, 'rust', 'a.rs').errors, ['a.rs:1 contract declaration is not attached to a test function']);
  assert.deepEqual(parseDeclarations('// contract:\n#[test]\nfn t() {}\n', 'rust', 'b.rs').errors, ['b.rs:1 contract declaration names no case']);
});

test('rust declarations bind through attributes and match module paths in results', () => {
  const rust = '#[cfg(test)]\nmod tests {\n    // contract: area.shared\n    #[tokio::test]\n    async fn shared() {}\n}\n';
  const parsed = parseDeclarations(rust, 'rust', 'src/a.rs');
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.tests.map((item) => [item.name, item.cases]), [['shared', ['area.shared']]]);
  const { errors } = auditHostContract(parseContractCases(SPEC), hosts({ rust, rustRuns: [owners('.', [['a::tests::shared', 'pass']])] }));
  assert.deepEqual(errors, []);
});

test('the case table rejects duplicate ids, invalid ids, and a limited scope without a reason', () => {
  const table = (rows) => `## Contract cases\n\n| Case | Behavior | Scope |\n| --- | --- | --- |\n${rows}\n`;
  assert.throws(() => parseContractCases(`\n${table('| `a.b` | x | both |\n| `a.b` | y | both |')}`), /defined twice/);
  assert.throws(() => parseContractCases(`\n${table('| `A.b` | x | both |')}`), /lowercase dotted/);
  assert.throws(() => parseContractCases(`\n${table('| `a.b` | x | tauriv2 only |')}`), /without a reason/);
  assert.throws(() => parseContractCases(`\n${table('| `a.b` | x | everywhere |')}`), /scope/);
  assert.throws(() => parseContractCases('# none\n'), /no "Contract cases" section/);
});

test('the late provider error case uses the registered Tauri host scope', () => {
  const spec = readFileSync(new URL('../../docs/spec/host-contract.md', import.meta.url), 'utf8');
  const contract = parseContractCases(spec).get('plugin-host.channel.late-error-preserved');
  assert.deepEqual(contract?.hosts, ['tauriv2']);
});

test('results are grouped by run and owner, and a name that one owner shares keeps a failure, then a pass, then a skip', () => {
  const item = (name, run, owner, testName) => ({ name, run, owner, testName });
  const items = [item('r1 p1.A', 'r1', 'p1', 'A'), item('r1 p2.A', 'r1', 'p2', 'A'), item('r1 p1.B', 'r1', 'p1', 'B'),
    item('r1 p1.C', 'r1', 'p1', 'C'), item('r1 p2.C', 'r1', 'p2', 'C'), item('r2 p1.A', 'r2', 'p1', 'A')];
  const result = (status, output = '') => ({ status, output });
  const results = new Map([
    ['r1 p1.A', result('pass')], ['r1 p2.A', result('fail')], ['r1 p1.B', result('timeout')],
    ['r1 p1.C', result('pass', '--- SKIP: C (0.00s)')], ['r1 p2.C', result('pass')], ['r2 p1.A', result('pass')],
  ]);
  const runs = groupResults(items, results);
  assert.deepEqual([...runs.get('r1').get('p1')], [['A', 'pass'], ['B', 'fail'], ['C', 'skip']]);
  assert.deepEqual([...runs.get('r1').get('p2')], [['A', 'fail'], ['C', 'pass']]);
  assert.deepEqual([...runs.get('r2').get('p1')], [['A', 'pass']]);
  const shared = groupResults([item('r3 a.X', 'r3', 'p1', 'X'), item('r3 b.X', 'r3', 'p1', 'X')],
    new Map([['r3 a.X', result('pass')], ['r3 b.X', result('fail')]]));
  assert.deepEqual([...shared.get('r3').get('p1')], [['X', 'fail']]);
});

test('a declaration takes its result only from the items of its own owner', () => {
  const host = 'packages/host/wailsv3/tests';
  const sok = 'packages/sok/wailsv3/tests';
  const body = 'package tests\n\n// contract: area.shared\nfunc TestShared(t *testing.T) {}\n';
  const tests = [...parseDeclarations(body, 'go', `${host}/a_test.go`).tests, ...parseDeclarations(body, 'go', `${sok}/a_test.go`).tests];
  const wails = { name: 'wailsv3', language: 'go', tests, errors: [], items: [], runs: [owners(host, [['TestShared', 'pass']])] };
  const [, tauri] = hosts({ go: body });
  const { errors } = auditHostContract(parseContractCases(ONE_CASE), [wails, tauri]);
  assert.deepEqual(errors, [`wailsv3: ${sok}/a_test.go:4 TestShared (area.shared) did not run`]);
});

test('owners of one run do not merge: a failing owner reports its own declaration as fail', () => {
  const host = 'packages/host/wailsv3/tests';
  const sok = 'packages/sok/wailsv3/tests';
  const body = 'package tests\n\n// contract: area.shared\nfunc TestShared(t *testing.T) {}\n';
  const tests = [...parseDeclarations(body, 'go', `${host}/a_test.go`).tests, ...parseDeclarations(body, 'go', `${sok}/a_test.go`).tests];
  const runs = [new Map([[host, new Map([['TestShared', 'pass']])], [sok, new Map([['TestShared', 'fail']])]])];
  const wails = { name: 'wailsv3', language: 'go', tests, errors: [], items: [], runs };
  const [, tauri] = hosts({ go: body });
  const { errors } = auditHostContract(parseContractCases(ONE_CASE), [wails, tauri]);
  assert.deepEqual(errors, [`wailsv3: ${sok}/a_test.go:4 TestShared (area.shared) reported fail`]);
});

test('two Rust tests with one leaf name in one crate and one run fail the audit', () => {
  const [wails, tauri] = hosts();
  const item = (owner, target, testName) => ({ name: `tauriv2-tests ${target}::${testName}`, run: 'tauriv2-tests', owner, target, testName });
  const duplicated = { ...tauri, items: [item('packages/host/tauriv2', 'a', 'shared'), item('packages/host/tauriv2', 'b', 'tests::shared')] };
  const { errors } = auditHostContract(parseContractCases(SPEC), [wails, duplicated]);
  assert.ok(errors.some((error) => error.includes('duplicate leaf shared')), errors.join('\n'));
  const apart = { ...tauri, items: [item('packages/host/tauriv2', 'a', 'shared'), item('packages/sok/tauriv2', 'b', 'shared')] };
  const other = auditHostContract(parseContractCases(SPEC), [wails, apart]);
  assert.deepEqual(other.errors.filter((error) => error.includes('duplicate leaf')), []);
});

test('a contract declaration accepts only test and feature attributes', () => {
  const allowed = '// contract: area.shared\n#[cfg(feature = "diagnostics")]\n#[test]\nfn shared() {}\n\n// contract: area.shared\n#[cfg(not(feature = "diagnostics"))]\n#[test]\nfn other() {}\n';
  const parsed = parseDeclarations(allowed, 'rust', 'a.rs');
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.tests.map((item) => item.name), ['shared', 'other']);
  assert.deepEqual(parseDeclarations('#[should_panic]\n#[test]\nfn plain() {}\n', 'rust', 'a.rs').errors, []);
  assert.deepEqual(parseDeclarations('// contract: area.shared\n#[should_panic]\n#[test]\nfn shared() {}\n', 'rust', 'a.rs').errors,
    ['a.rs:2 attribute #[should_panic] is not allowed on a contract test']);
  assert.deepEqual(parseDeclarations('#[ignore]\n// contract: area.shared\n#[test]\nfn shared() {}\n', 'rust', 'a.rs').errors,
    ['a.rs:1 attribute #[ignore] is not allowed on a contract test']);
});

test('the static audit fails a marker that names an undefined case, a case outside its scope, or no case, without running tests', () => {
  const cases = parseContractCases(SPEC);
  const undefinedCase = parseDeclarations('// contract: area.missing\n#[test]\nfn shared() {}\n', 'rust', 'tauri_test.rs');
  const outsideScope = parseDeclarations('// contract: area.wails-only\n#[test]\nfn shared() {}\n', 'rust', 'tauri_test.rs');
  const noCase = parseDeclarations('// contract:\n#[test]\nfn shared() {}\n', 'rust', 'tauri_test.rs');
  const undefinedErrors = auditDeclarations(cases, [staticHost('tauriv2', 'rust', undefinedCase)]).errors;
  assert.ok(undefinedErrors.some((error) => error.includes('declares undefined contract case area.missing')), undefinedErrors.join('\n'));
  const scopeErrors = auditDeclarations(cases, [staticHost('tauriv2', 'rust', outsideScope)]).errors;
  assert.ok(scopeErrors.some((error) => error.includes('declares area.wails-only, which the specification limits to wailsv3')), scopeErrors.join('\n'));
  const emptyErrors = auditDeclarations(cases, [staticHost('tauriv2', 'rust', noCase)]).errors;
  assert.ok(emptyErrors.some((error) => error.includes('declares no contract case')), emptyErrors.join('\n'));
});

test('the static audit reports each case of a host scope that no test declares', () => {
  const cases = parseContractCases(SPEC);
  const wails = parseDeclarations(GO, 'go', `${GO_OWNER}/wails_test.go`);
  const tauri = parseDeclarations('// contract: area.shared\n#[test]\nfn shared() {}\n', 'rust', 'tauri_test.rs');
  const { declared } = auditDeclarations(cases, [staticHost('wailsv3', 'go', wails), staticHost('tauriv2', 'rust', tauri)]);
  assert.deepEqual(uncoveredCases(cases, declared), []);
  const missing = parseDeclarations('// contract: area.shared\n#[test]\nfn shared() {}\n', 'rust', 'tauri_test.rs');
  const partial = auditDeclarations(cases, [staticHost('wailsv3', 'go', parseDeclarations('package tests\n', 'go', 'w_test.go')), staticHost('tauriv2', 'rust', missing)]);
  assert.deepEqual(uncoveredCases(cases, partial.declared), ['wailsv3 declares no test for contract case area.shared', 'wailsv3 declares no test for contract case area.wails-only']);
});


test('the macOS static inventory excludes Windows-only Go tests', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const files = goTestSourceFilesForRun({
    cwd: root,
    patterns: ['./packages/sok/wailsv3/...'],
    id: 'macOS Wails sok source inventory',
  });
  assert.ok(files.includes('packages/sok/wailsv3/tests/platform/darwin/private_files_test.go'));
  assert.ok(!files.includes('packages/sok/wailsv3/tests/platform/linux/process_wait_test.go'));
  assert.ok(!files.includes('packages/sok/wailsv3/tests/platform/windows/private_files_test.go'));
  assert.ok(!files.includes('packages/sok/wailsv3/tests/platform/windows/process_wait_test.go'));
});

test('Go test source inventory follows target and tag selection and reports list errors', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'host-contract-go-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'go.mod'), 'module fixture.local/contract\n\ngo 1.23.0\n');
  writeFileSync(join(root, 'fixture.go'), 'package fixture\n');
  writeFileSync(join(root, 'external_test.go'), 'package fixture_test\nimport ("testing"; fixture "fixture.local/contract")\nfunc TestExternal(t *testing.T) { _ = fixture.Exported }\n');
  writeFileSync(join(root, 'fixture.go'), 'package fixture\n\nconst Exported = true\n');
  const files = {
    common_test: 'package fixture\nimport "testing"\nfunc TestCommon(t *testing.T) {}\n',
    darwin_test: '//go:build darwin\n\npackage fixture\nimport "testing"\nfunc TestDarwin(t *testing.T) {}\n',
    linux_test: '//go:build linux\n\npackage fixture\nimport "testing"\nfunc TestLinux(t *testing.T) {}\n',
    windows_test: '//go:build windows\n\npackage fixture\nimport "testing"\nfunc TestWindows(t *testing.T) {}\n',
    diagnostics_test: '//go:build diagnostics\n\npackage fixture\nimport "testing"\nfunc TestDiagnostics(t *testing.T) {}\n',
    dev_test: '//go:build dev\n\npackage fixture\nimport "testing"\nfunc TestDev(t *testing.T) {}\n',
  };
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, `${name}.go`), contents);
  const list = (goos, tags, patterns = ['./...']) => goTestSourceFilesForRun({
    cwd: root,
    patterns,
    tags,
    id: `fixture-${goos}-${tags || 'default'}`,
    env: { ...process.env, GOOS: goos, GOARCH: 'amd64', GO111MODULE: 'on', GOWORK: 'off' },
  });
  const common = ['common_test.go', 'external_test.go'];
  assert.deepEqual(list('darwin'), ['common_test.go', 'darwin_test.go', 'external_test.go']);
  assert.deepEqual(list('windows'), ['common_test.go', 'external_test.go', 'windows_test.go']);
  assert.deepEqual(list('linux'), ['common_test.go', 'external_test.go', 'linux_test.go']);
  assert.deepEqual(list('darwin', 'diagnostics'), ['common_test.go', 'darwin_test.go', 'diagnostics_test.go', 'external_test.go']);
  assert.deepEqual(list('windows', 'diagnostics dev'), ['common_test.go', 'dev_test.go', 'diagnostics_test.go', 'external_test.go', 'windows_test.go']);
  assert.throws(() => list('darwin', undefined, ['./missing-package']), /go list test-source inventory failed.*fixture-darwin-default/);
});

test('Go recursive inventory includes nested packages and preserves commas in test filenames', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'host-contract-go-recursive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'go.mod'), 'module fixture.local/recursive\n\ngo 1.23.0\n');
  writeFileSync(join(root, 'fixture.go'), 'package fixture\n');
  writeFileSync(join(root, 'common_test.go'), 'package fixture\nimport "testing"\nfunc TestCommon(t *testing.T) {}\n');
  writeFileSync(join(root, 'comma,name_test.go'), 'package fixture\nimport "testing"\nfunc TestComma(t *testing.T) {}\n');
  mkdirSync(join(root, 'child'));
  writeFileSync(join(root, 'child', 'child.go'), 'package child\n');
  writeFileSync(join(root, 'child', 'child_test.go'), 'package child\nimport "testing"\nfunc TestChild(t *testing.T) {}\n');
  const files = goTestSourceFilesForRun({
    cwd: root,
    patterns: ['./...'],
    env: { ...process.env, GOOS: 'darwin', GOARCH: 'arm64', GO111MODULE: 'on', GOWORK: 'off' },
  });
  assert.deepEqual(files, ['child/child_test.go', 'comma,name_test.go', 'common_test.go']);
});

test('Go source inventory rejects a successful list command with no packages', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'host-contract-go-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'go.mod'), 'module fixture.local/empty\n\ngo 1.23.0\n');
  mkdirSync(join(root, 'testdata'));
  writeFileSync(join(root, 'testdata', 'ignored.go'), 'package ignored\n');
  assert.throws(() => goTestSourceFilesForRun({
    cwd: root,
    patterns: ['./...'],
    env: { ...process.env, GOOS: 'darwin', GOARCH: 'arm64', GO111MODULE: 'on', GOWORK: 'off' },
  }), /go list test-source inventory failed.*found no packages/);
});

test('Go source inventory reports and bounds a stuck go list process', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'host-contract-go-timeout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const fakeGo = join(bin, 'go');
  writeFileSync(fakeGo, '#!/bin/sh\nexec /bin/sleep 1\n');
  chmodSync(fakeGo, 0o755);
  const output = [];
  assert.throws(() => goTestSourceFilesForRun({
    cwd: root,
    patterns: ['./...'],
    timeoutMs: 25,
    write: (line) => output.push(line),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GOOS: 'darwin', GOARCH: 'arm64' },
  }), /go list test-source inventory failed.*timed out/);
  assert.match(output[0], /^RUN  go list test-source inventory/);
  assert.match(output[1], /^FAIL go list test-source inventory.*after \d+\.\d+s:/);
});

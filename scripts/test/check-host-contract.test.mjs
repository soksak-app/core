import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditHostContract, parseContractCases, parseDeclarations, parseGoResults, parseRustResults } from '../check-host-contract.mjs';

const SPEC = `# Hosts

## Contract cases

| Case | Behavior | Scope |
| --- | --- | --- |
| \`area.shared\` | Both hosts do this. | both |
| \`area.wails-only\` | Only Wails does this. | wailsv3 only: the framework owns it |

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

function hosts({ go = GO, rust = RUST, goRuns, rustRuns } = {}) {
  const wails = parseDeclarations(go, 'go', 'wails_test.go');
  const tauri = parseDeclarations(rust, 'rust', 'tauri_test.rs');
  return [
    { name: 'wailsv3', language: 'go', ...wails, runs: goRuns ?? [new Map([['TestShared', 'pass'], ['TestWailsOnly', 'pass']])] },
    { name: 'tauriv2', language: 'rust', ...tauri, runs: rustRuns ?? [new Map([['shared', 'pass']])] },
  ];
}

test('host contract passes when each host runs a passing test for every case in its scope', () => {
  const { errors, covered } = auditHostContract(parseContractCases(SPEC), hosts());
  assert.deepEqual(errors, []);
  assert.deepEqual([...covered.get('wailsv3')].sort(), ['area.shared', 'area.wails-only']);
  assert.deepEqual([...covered.get('tauriv2')], ['area.shared']);
});

test('a host without a test for a shared case fails', () => {
  const { errors } = auditHostContract(parseContractCases(SPEC), hosts({ rust: '#[test]\nfn other() {}\n', rustRuns: [new Map([['other', 'pass']])] }));
  assert.ok(errors.includes('tauriv2 runs no passing test for contract case area.shared'), errors.join('\n'));
  assert.ok(errors.some((error) => error.includes('other declares no contract case')), errors.join('\n'));
});

test('a declared test that did not run, failed, or was skipped does not cover its case', () => {
  for (const [status, text] of [[undefined, 'did not run'], ['fail', 'reported fail'], ['skip', 'reported skip']]) {
    const runs = [new Map(status ? [['shared', status]] : [['unrelated', 'pass']])];
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
  const { errors } = auditHostContract(parseContractCases(SPEC), hosts({ rust, rustRuns: [new Map([['shared', 'pass'], ['other', 'pass']])] }));
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
  const { errors } = auditHostContract(parseContractCases(SPEC), hosts({ rust, rustRuns: [new Map([['a::tests::shared', 'pass']])] }));
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

test('runner output parsers keep top-level results and ignore subtests', () => {
  const go = [
    '{"Action":"run","Test":"TestA"}',
    '{"Action":"pass","Test":"TestA/sub"}',
    '{"Action":"pass","Test":"TestA"}',
    '{"Action":"skip","Test":"TestB"}',
    '{"Action":"fail","Test":"TestC"}',
    'not json',
  ].join('\n');
  assert.deepEqual([...parseGoResults(go)], [['TestA', 'pass'], ['TestB', 'skip'], ['TestC', 'fail']]);
  const rust = 'running 3 tests\ntest a ... ok\ntest m::b ... FAILED\ntest c ... ignored\ntest result: FAILED.';
  assert.deepEqual([...parseRustResults(rust)], [['a', 'pass'], ['m::b', 'fail'], ['c', 'skip']]);
});

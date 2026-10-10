// 두 호스트(Wails, Tauri)가 호스트 명세의 계약 사례를 같은 수준으로 실행하는지 검사한다.
//
// 계약 사례는 docs/spec/host-contract.md 의 "Contract cases" 표가 정의한다. 각 호스트의 테스트 함수는 바로 위의
// `// contract: <id>[, <id>]` 줄로 실행하는 사례를 선언한다. 검사는 두 호스트의 테스트를 기본 구성과 diagnostics
// 구성으로 실제 실행하고, 선언한 테스트가 실행되어 통과했는지 결과로 판단한다. 파일 이름이나 개수는 쓰지 않는다.
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus } from 'node:os';
import { auditStatus, discoverGo, discoverRust } from './test-discovery.mjs';
import { runTests } from './test-runner.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SPEC = 'docs/spec/host-contract.md';
const HOSTS = ['wailsv3', 'tauriv2'];
const CASE_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

/** 명세의 "Contract cases" 표에서 사례 ID, 동작, 범위를 읽는다. 범위는 `both` 이거나 한 호스트 이름이다. */
export function parseContractCases(markdown) {
  const start = markdown.indexOf('\n## Contract cases\n');
  if (start < 0) throw new Error(`${SPEC} has no "Contract cases" section`);
  const next = markdown.indexOf('\n## ', start + 1);
  const section = markdown.slice(start, next < 0 ? undefined : next);
  const cases = new Map();
  for (const line of section.split('\n')) {
    const row = line.match(/^\|\s*`([^`]+)`\s*\|(.*)\|\s*$/);
    if (!row) continue;
    const [id, cells] = [row[1], row[2].split('|').map((cell) => cell.trim())];
    if (!CASE_ID.test(id)) throw new Error(`contract case id ${id} is not a lowercase dotted identifier`);
    if (cases.has(id)) throw new Error(`contract case ${id} is defined twice`);
    const [behavior, scope] = cells;
    if (!behavior) throw new Error(`contract case ${id} has no behavior`);
    const hosts = scope === 'both' ? HOSTS : HOSTS.filter((host) => scope?.startsWith(`${host} only`));
    if (hosts.length === 0) throw new Error(`contract case ${id} has scope "${scope}"; use "both" or "<host> only: <reason>"`);
    if (hosts.length === 1 && !/only:\s*\S/.test(scope)) throw new Error(`contract case ${id} limits its scope without a reason`);
    cases.set(id, { behavior, hosts });
  }
  if (cases.size === 0) throw new Error(`${SPEC} defines no contract cases`);
  return cases;
}

const TEST_FUNCTION = {
  go: /^func (Test\w+)\(t \*testing\.T\)/,
  rust: /^\s*(?:pub\s+)?(?:async\s+)?fn (\w+)\s*\(/,
};

/** 테스트 소스에서 테스트 함수와 그 함수가 선언한 계약 사례를 읽는다. */
export function parseDeclarations(source, language, file) {
  const pattern = TEST_FUNCTION[language];
  if (!pattern) throw new Error(`unsupported language ${language}`);
  const tests = [];
  const errors = [];
  let pending = null;
  let testAttribute = false;
  source.split('\n').forEach((line, index) => {
    const declaration = line.match(/^\s*\/\/\s*contract:\s*(.*)$/);
    if (declaration) {
      const ids = declaration[1].split(',').map((id) => id.trim()).filter(Boolean);
      if (ids.length === 0) errors.push(`${file}:${index + 1} contract declaration names no case`);
      pending = pending ?? { ids: [], line: index + 1 };
      pending.ids.push(...ids);
      return;
    }
    if (language === 'rust' && /^\s*#\[(?:tokio::)?test\b/.test(line)) {
      testAttribute = true;
      return;
    }
    const match = line.match(pattern);
    const isTest = match && (language === 'go' || testAttribute);
    if (isTest) {
      tests.push({ name: match[1], file, line: index + 1, cases: pending?.ids ?? [] });
      pending = null;
      testAttribute = false;
      return;
    }
    if (/^\s*(\/\/|#\[|$)/.test(line)) return;
    if (pending) errors.push(`${file}:${pending.line} contract declaration is not attached to a test function`);
    pending = null;
    testAttribute = false;
  });
  if (pending) errors.push(`${file}:${pending.line} contract declaration is not attached to a test function`);
  return { tests, errors };
}

/**
 * Per run id, the test name to its audit status (`pass`, `fail`, `skip`) from the finished tests. A name that several packages
 * of one run share keeps a failure, then a pass, then a skip.
 */
export function groupResults(items, results) {
  const order = { fail: 3, pass: 2, skip: 1 };
  const runs = new Map();
  for (const item of items) {
    const status = auditStatus(results.get(item.name));
    const named = runs.get(item.run) ?? new Map();
    if (!named.has(item.testName) || order[status] > order[named.get(item.testName)]) named.set(item.testName, status);
    runs.set(item.run, named);
  }
  return runs;
}

function statusOf(test, language, runs) {
  const statuses = [];
  for (const results of runs) {
    for (const [name, status] of results) {
      if (name === test.name || (language === 'rust' && name.endsWith(`::${test.name}`))) statuses.push(status);
    }
  }
  if (statuses.length === 0) return 'not run';
  if (statuses.includes('fail')) return 'fail';
  if (statuses.every((status) => status === 'skip')) return 'skip';
  return statuses.includes('skip') ? 'skip' : 'pass';
}

/**
 * 계약 사례와 호스트별 선언·실행 결과를 비교한다.
 * hosts: [{ name, language, tests, errors, runs }] — runs 는 구성마다 테스트 이름 → 결과 Map 이다.
 */
export function auditHostContract(cases, hosts) {
  const errors = [];
  const covered = new Map(hosts.map((host) => [host.name, new Set()]));
  for (const host of hosts) {
    errors.push(...host.errors.map((error) => `${host.name}: ${error}`));
    if (host.runs.every((results) => results.size === 0)) errors.push(`${host.name}: the test run reported zero tests`);
    for (const test of host.tests) {
      const where = `${host.name}: ${test.file}:${test.line} ${test.name}`;
      if (test.cases.length === 0) {
        errors.push(`${where} declares no contract case`);
        continue;
      }
      const status = statusOf(test, host.language, host.runs);
      if (status !== 'pass') errors.push(`${where} (${test.cases.join(', ')}) ${status === 'not run' ? 'did not run' : `reported ${status}`}`);
      for (const id of test.cases) {
        const contract = cases.get(id);
        if (!contract) errors.push(`${where} declares undefined contract case ${id}`);
        else if (!contract.hosts.includes(host.name)) errors.push(`${where} declares ${id}, which the specification limits to ${contract.hosts.join(', ')}`);
        else if (status === 'pass') covered.get(host.name).add(id);
      }
    }
  }
  for (const [id, contract] of cases) {
    for (const name of contract.hosts) {
      const host = hosts.find((item) => item.name === name);
      if (!host) errors.push(`contract case ${id} requires host ${name}, which was not checked`);
      else if (!covered.get(name).has(id)) errors.push(`${name} runs no passing test for contract case ${id}`);
    }
  }
  return { errors, covered };
}

function sources(directory, extension) {
  const result = [];
  const walk = (path) => {
    for (const entry of readdirSync(join(ROOT, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(extension)) result.push(child);
    }
  };
  walk(directory);
  return result.sort();
}

const HOST_SOURCES = {
  wailsv3: { language: 'go', files: () => [...sources('packages/host/wailsv3/tests', '_test.go'), ...sources('packages/host/wailsv3/src', '_test.go'), ...sources('packages/sok/wailsv3/tests', '_test.go')] },
  tauriv2: { language: 'rust', files: () => [...sources('packages/host/tauriv2/tests', '.rs'), ...sources('packages/host/tauriv2/src', '.rs'), ...sources('packages/sok/tauriv2/tests', '.rs')] },
};

/** The limit of one contract test. A test that needs more is reported by the run and gets its own limit with its reason. */
const TEST_TIMEOUT_MS = 120_000;

const GO_RUNS = (ldflags) => [
  { id: 'wailsv3-tests', patterns: ['./packages/host/wailsv3/...'], ldflags },
  { id: 'wailsv3-diagnostics-tests', patterns: ['./packages/host/wailsv3/...'], tags: 'diagnostics', ldflags },
  { id: 'wailsv3-sok-tests', patterns: ['./packages/sok/wailsv3/...'] },
  { id: 'wailsv3-sok-diagnostics-tests', patterns: ['./packages/sok/wailsv3/...'], tags: 'diagnostics' },
  { id: 'wailsv3-sok-dev-tests', patterns: ['./packages/sok/wailsv3/...'], tags: 'diagnostics dev' },
];

const RUST_RUNS = [
  { id: 'tauriv2-tests', packageName: 'soksak-host-tauriv2' },
  { id: 'tauriv2-diagnostics-tests', packageName: 'soksak-host-tauriv2', features: 'diagnostics' },
  { id: 'tauriv2-sok-tests', packageName: 'soksak-sok-tauriv2' },
  { id: 'tauriv2-sok-diagnostics-tests', packageName: 'soksak-sok-tauriv2', features: 'diagnostics' },
  { id: 'tauriv2-sok-dev-tests', packageName: 'soksak-sok-tauriv2', features: 'diagnostics,dev' },
];

async function main(argv) {
  const flagIndex = argv.indexOf('--go-ldflags');
  if (flagIndex < 0 || !argv[flagIndex + 1]) throw new Error('usage: check-host-contract.mjs --go-ldflags <flags>');
  const cases = parseContractCases(readFileSync(join(ROOT, SPEC), 'utf8'));
  const write = (line) => process.stdout.write(`${line}\n`);
  const concurrency = Math.max(2, cpus().length - 2);
  const buildDir = mkdtempSync(join(tmpdir(), 'host-contract-'));
  // Go builds run together; the Rust builds share one cargo lock, so they follow one another. Both languages build at once.
  // A scoped run builds only the runs whose id contains the text of --run.
  const runIndex = argv.indexOf('--run');
  const runText = runIndex < 0 ? '' : argv[runIndex + 1];
  if (runIndex >= 0 && !runText) throw new Error('--run needs a text that the id of a run contains');
  const goDiscovery = Promise.all(GO_RUNS(argv[flagIndex + 1]).filter((run) => run.id.includes(runText)).map((run) => discoverGo({ ...run, cwd: ROOT, buildDir, write, concurrency })));
  const rustDiscovery = (async () => {
    const found = [];
    for (const run of RUST_RUNS.filter((entry) => entry.id.includes(runText))) found.push(await discoverRust({ ...run, cwd: ROOT, write }));
    return found;
  })();
  const [goFound, rustFound] = await Promise.all([goDiscovery, rustDiscovery]);
  const found = { wailsv3: goFound, tauriv2: rustFound };
  const onlyIndex = argv.indexOf('--only');
  const only = onlyIndex < 0 ? null : argv[onlyIndex + 1];
  if (onlyIndex >= 0 && !only) throw new Error('--only needs a text that the name of a test contains');
  const items = [...goFound, ...rustFound].flatMap((entry) => entry.tests).filter((item) => only === null || item.name.includes(only));
  if (only !== null) {
    // A scoped run shows the tests it ran; the contract audit needs every test, so it belongs to the full run.
    if (items.length === 0) throw new Error(`no test name contains ${JSON.stringify(only)}`);
    write(`RUN  ${items.length} tests with ${concurrency} at once, each limited to ${TEST_TIMEOUT_MS / 1000}s (scoped by ${JSON.stringify(only)}; no contract audit)`);
    const scoped = await runTests({ tests: items, concurrency, defaultTimeoutMs: TEST_TIMEOUT_MS, write });
    return [...scoped.results.values()].every((result) => result.status === 'pass') ? 0 : 1;
  }
  write(`RUN  ${items.length} tests with ${concurrency} at once, each limited to ${TEST_TIMEOUT_MS / 1000}s`);
  const { results } = await runTests({ tests: items, concurrency, defaultTimeoutMs: TEST_TIMEOUT_MS, write });
  const hosts = [];
  for (const name of HOSTS) {
    const { language, files } = HOST_SOURCES[name];
    const tests = [];
    const errors = found[name].flatMap((entry) => entry.failures);
    for (const file of files()) {
      const parsed = parseDeclarations(readFileSync(join(ROOT, file), 'utf8'), language, relative(ROOT, join(ROOT, file)));
      tests.push(...parsed.tests);
      errors.push(...parsed.errors);
    }
    const own = found[name].flatMap((entry) => entry.tests);
    for (const item of own) {
      if (results.get(item.name).status === 'timeout') errors.push(`${item.name} exceeded its limit of ${TEST_TIMEOUT_MS / 1000}s`);
    }
    hosts.push({ name, language, tests, errors, runs: [...groupResults(own, results).values()] });
  }
  const { errors, covered } = auditHostContract(cases, hosts);
  for (const host of hosts) {
    const required = [...cases.values()].filter((contract) => contract.hosts.includes(host.name)).length;
    process.stdout.write(`${host.name}: ${covered.get(host.name).size} of ${required} contract cases pass; ${host.tests.length} tests\n`);
  }
  if (errors.length > 0) {
    process.stderr.write(`Host contract check failed: ${errors.length} issue(s)\n${errors.map((error) => `- ${error}`).join('\n')}\n`);
    return 1;
  }
  process.stdout.write(`Host contract check passed: ${cases.size} contract cases\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

// 두 호스트(Wails, Tauri)가 호스트 명세의 계약 사례를 같은 수준으로 실행하는지 검사한다.
//
// 계약 사례는 docs/spec/host-contract.md 의 "Contract cases" 표가 정의한다. 각 호스트의 테스트 함수는 바로 위의
// `// contract: <id>[, <id>]` 줄로 실행하는 사례를 선언한다. 검사는 두 호스트의 테스트를 기본 구성과 diagnostics
// 구성으로 실제 실행하고, 선언한 테스트가 실행되어 통과했는지 결과로 판단한다. 파일 이름이나 개수는 쓰지 않는다.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCommand } from './test-command.mjs';

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

/** `go test -json` 출력에서 최상위 테스트의 결과를 읽는다. */
export function parseGoResults(output) {
  const results = new Map();
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event.Test || event.Test.includes('/')) continue;
    if (event.Action === 'pass' || event.Action === 'fail' || event.Action === 'skip') results.set(event.Test, event.Action);
  }
  return results;
}

/** `cargo test` 출력에서 테스트 결과를 읽는다. 모듈 안의 테스트 이름은 경로를 포함한다. */
export function parseRustResults(output) {
  const results = new Map();
  for (const line of output.split('\n')) {
    const match = line.match(/^test (\S+) \.\.\. (ok|FAILED|ignored)\b/);
    if (match) results.set(match[1], { ok: 'pass', FAILED: 'fail', ignored: 'skip' }[match[2]]);
  }
  return results;
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

function hostRuns(goLinkFlags) {
  return {
    wailsv3: [
      { id: 'wailsv3-tests', command: 'go', args: ['test', '-count=1', '-json', '-ldflags', goLinkFlags, './packages/host/wailsv3/...'] },
      { id: 'wailsv3-diagnostics-tests', command: 'go', args: ['test', '-count=1', '-json', '-tags', 'diagnostics', '-ldflags', goLinkFlags, './packages/host/wailsv3/...'] },
      { id: 'wailsv3-sok-tests', command: 'go', args: ['test', '-count=1', '-json', './packages/sok/wailsv3/...'] },
    ],
    tauriv2: [
      { id: 'tauriv2-tests', command: 'cargo', args: ['test', '-p', 'soksak-host-tauriv2'] },
      { id: 'tauriv2-diagnostics-tests', command: 'cargo', args: ['test', '-p', 'soksak-host-tauriv2', '--features', 'diagnostics'] },
      { id: 'tauriv2-sok-tests', command: 'cargo', args: ['test', '-p', 'soksak-sok-tauriv2'] },
    ],
  };
}

async function main(argv) {
  const flagIndex = argv.indexOf('--go-ldflags');
  if (flagIndex < 0 || !argv[flagIndex + 1]) throw new Error('usage: check-host-contract.mjs --go-ldflags <flags>');
  const cases = parseContractCases(readFileSync(join(ROOT, SPEC), 'utf8'));
  const runs = hostRuns(argv[flagIndex + 1]);
  const hosts = [];
  for (const name of HOSTS) {
    const { language, files } = HOST_SOURCES[name];
    const tests = [];
    const errors = [];
    for (const file of files()) {
      const parsed = parseDeclarations(readFileSync(join(ROOT, file), 'utf8'), language, relative(ROOT, join(ROOT, file)));
      tests.push(...parsed.tests);
      errors.push(...parsed.errors);
    }
    const results = [];
    for (const run of runs[name]) {
      const result = await runCommand({ ...run, cwd: ROOT, timeoutMs: 600_000, onEvent: (event) => {
        if (event.type !== 'progress') process.stderr.write(`${event.id} ${event.type} ${event.elapsedMs}ms\n`);
      } });
      const parsed = language === 'go' ? parseGoResults(result.stdout) : parseRustResults(`${result.stdout}\n${result.stderr}`);
      if (result.status !== 'pass') errors.push(`${run.id} ${result.status} (exit ${result.exitCode}, signal ${result.signal})`);
      results.push(parsed);
    }
    hosts.push({ name, language, tests, errors, runs: results });
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

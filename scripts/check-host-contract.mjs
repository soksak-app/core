// Checks that the two hosts (Wails and Tauri) run the contract cases of the host specification at the same level.
//
// The contract cases are defined by the "Contract cases" table of docs/spec/host-contract.md. The test function of each host declares the case it runs with the line
// `// contract: <id>[, <id>]` right above it. The check actually runs the tests of both hosts in the default configuration and the diagnostics
// configuration and judges from the results whether the declared tests ran and passed. It does not use file names or counts.
import { parseArgs } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus } from 'node:os';
import { auditStatus, discoverGo, discoverRust } from './test-discovery.mjs';
import { runTests } from './test-runner.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SPEC = 'docs/spec/host-contract.md';
const HOSTS = ['wailsv3', 'tauriv2'];
const CASE_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

/** Reads the case ID, behavior, and scope from the "Contract cases" table of the specification. The scope is `both` or the name of one host. */
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

/** The attribute lines that a contract test may carry: the test attribute and the feature selection of its configuration. */
const ALLOWED_ATTRIBUTES = [
  /^#\[test\]$/,
  /^#\[tokio::test\]$/,
  /^#\[cfg\(feature\s*=\s*"[^"]+"\)\]$/,
  /^#\[cfg\(not\(feature\s*=\s*"[^"]+"\)\)\]$/,
];
const TEST_ATTRIBUTE = /^#\[(?:tokio::)?test\b/;

/** The directory of a file of the repository, as the owner of its declarations (`.` for the root). */
export function ownerOfFile(file) {
  return posix.dirname(file);
}

/**
 * Reads the test functions from the test source and the contract cases that each function declares. `owner` is the package
 * directory (Go) or the crate directory (Rust) that the caller computes from the file; each test carries it, so a result is
 * matched only with items of the same owner.
 */
export function parseDeclarations(source, language, file, owner = ownerOfFile(file)) {
  const pattern = TEST_FUNCTION[language];
  if (!pattern) throw new Error(`unsupported language ${language}`);
  const tests = [];
  const errors = [];
  let pending = null;
  // Rust: the attribute lines since the last code line, with their line numbers; a comment or blank line keeps them.
  let attributes = [];
  source.split('\n').forEach((line, index) => {
    const declaration = line.match(/^\s*\/\/\s*contract:\s*(.*)$/);
    if (declaration) {
      const ids = declaration[1].split(',').map((id) => id.trim()).filter(Boolean);
      if (ids.length === 0) errors.push(`${file}:${index + 1} contract declaration names no case`);
      pending = pending ?? { ids: [], line: index + 1 };
      pending.ids.push(...ids);
      return;
    }
    if (language === 'rust' && /^\s*#\[/.test(line)) {
      attributes.push({ text: line.trim(), line: index + 1 });
      return;
    }
    const match = line.match(pattern);
    if (match && (language === 'go' || attributes.some((attribute) => TEST_ATTRIBUTE.test(attribute.text)))) {
      if (pending) {
        for (const attribute of attributes) {
          if (!ALLOWED_ATTRIBUTES.some((allowed) => allowed.test(attribute.text))) {
            errors.push(`${file}:${attribute.line} attribute ${attribute.text} is not allowed on a contract test`);
          }
        }
      }
      tests.push({ name: match[1], file, line: index + 1, cases: pending?.ids ?? [], owner });
      pending = null;
      attributes = [];
      return;
    }
    if (/^\s*(\/\/|$)/.test(line)) return;
    if (pending) errors.push(`${file}:${pending.line} contract declaration is not attached to a test function`);
    pending = null;
    attributes = [];
  });
  if (pending) errors.push(`${file}:${pending.line} contract declaration is not attached to a test function`);
  return { tests, errors };
}

/** The leaf name of a result name: the last path segment of a Rust module path, or the name itself. */
export function leafOf(name) {
  return name.split('::').pop();
}

/**
 * The Rust leaf names that several tests of one crate share in one run. A declaration matches one leaf, so such a name
 * fails the audit whatever targets hold the tests. Returns one message per shared leaf.
 */
export function duplicateLeaves(items) {
  const groups = new Map();
  for (const item of items) {
    const key = [item.run, item.owner, leafOf(item.testName)].join('\n');
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].filter((group) => group.length > 1).map((group) => {
    const [first] = group;
    const tests = group.map((item) => `${item.target}::${item.testName}`).join(', ');
    return `duplicate leaf ${leafOf(first.testName)} in ${first.owner} of run ${first.run}: ${tests}`;
  });
}

/** The crate directory of a Rust source: the nearest ancestor of the file (relative to `root`) that holds Cargo.toml. */
export function crateOwnerOf(file, root = ROOT) {
  let dir = posix.dirname(file);
  for (;;) {
    if (existsSync(join(root, dir, 'Cargo.toml'))) return dir;
    if (dir === '.') throw new Error(`${file} has no Cargo.toml in any ancestor folder`);
    dir = posix.dirname(dir);
  }
}

/**
 * Per run id, the owner, then the test name, to its audit status (`pass`, `fail`, `skip`) from the finished tests. A name that
 * one owner shares in one run keeps a failure, then a pass, then a skip. Owners never merge.
 */
export function groupResults(items, results) {
  const order = { fail: 3, pass: 2, skip: 1 };
  const runs = new Map();
  for (const item of items) {
    const status = auditStatus(results.get(item.name));
    const owners = runs.get(item.run) ?? new Map();
    const named = owners.get(item.owner) ?? new Map();
    if (!named.has(item.testName) || order[status] > order[named.get(item.testName)]) named.set(item.testName, status);
    owners.set(item.owner, named);
    runs.set(item.run, owners);
  }
  return runs;
}

/** The statuses of the results that a declaration matches: the same owner, and the same name or the Rust leaf name. */
function statusOf(test, language, runs) {
  const statuses = [];
  for (const owners of runs) {
    const named = owners.get(test.owner);
    if (!named) continue;
    for (const [name, status] of named) {
      if (name === test.name || (language === 'rust' && leafOf(name) === test.name)) statuses.push(status);
    }
  }
  if (statuses.length === 0) return 'not run';
  if (statuses.includes('fail')) return 'fail';
  if (statuses.every((status) => status === 'skip')) return 'skip';
  return statuses.includes('skip') ? 'skip' : 'pass';
}

/**
 * Compares the declarations of each host with the contract cases, without run results: parse errors, tests without a case,
 * undefined cases, and cases outside the host scope. Returns the errors and, per host, the set of cases its tests declare.
 * hosts: [{ name, language, tests, errors }].
 */
export function auditDeclarations(cases, hosts) {
  const errors = [];
  const declared = new Map(hosts.map((host) => [host.name, new Set()]));
  for (const host of hosts) {
    errors.push(...host.errors.map((error) => `${host.name}: ${error}`));
    for (const test of host.tests) {
      const where = `${host.name}: ${test.file}:${test.line} ${test.name}`;
      if (test.cases.length === 0) {
        errors.push(`${where} declares no contract case`);
        continue;
      }
      for (const id of test.cases) {
        const contract = cases.get(id);
        if (!contract) errors.push(`${where} declares undefined contract case ${id}`);
        else if (!contract.hosts.includes(host.name)) errors.push(`${where} declares ${id}, which the specification limits to ${contract.hosts.join(', ')}`);
        else declared.get(host.name).add(id);
      }
    }
  }
  return { errors, declared };
}

/** The errors of each contract case that a host in its scope has no test declaring. `declared` is the result of auditDeclarations. */
export function uncoveredCases(cases, declared) {
  const errors = [];
  for (const [id, contract] of cases) {
    for (const name of contract.hosts) {
      if (!declared.get(name)?.has(id)) errors.push(`${name} declares no test for contract case ${id}`);
    }
  }
  return errors;
}

/**
 * Compares the contract cases with the declarations and the run results of each host.
 * hosts: [{ name, language, tests, errors, runs }] — runs maps the test name to its result for each configuration.
 */
export function auditHostContract(cases, hosts) {
  const { errors, declared } = auditDeclarations(cases, hosts);
  const covered = new Map(hosts.map((host) => [host.name, new Set()]));
  for (const host of hosts) {
    if (host.runs.every((owners) => [...owners.values()].every((named) => named.size === 0))) errors.push(`${host.name}: the test run reported zero tests`);
    if (host.language === 'rust') errors.push(...duplicateLeaves(host.items ?? []).map((error) => `${host.name}: ${error}`));
    for (const test of host.tests) {
      if (test.cases.length === 0) continue;
      const where = `${host.name}: ${test.file}:${test.line} ${test.name}`;
      const status = statusOf(test, host.language, host.runs);
      if (status !== 'pass') errors.push(`${where} (${test.cases.join(', ')}) ${status === 'not run' ? 'did not run' : `reported ${status}`}`);
      if (status === 'pass') for (const id of test.cases) if (declared.get(host.name).has(id)) covered.get(host.name).add(id);
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
  wailsv3: { language: 'go', files: () => [...sources('packages/host/wailsv3/tests', '_test.go'), ...sources('packages/host/wailsv3/src', '_test.go'), ...sources('packages/sok/wailsv3/tests', '_test.go'), ...sources('packages/sok/wailsv3/src', '_test.go')] },
  tauriv2: { language: 'rust', files: () => [...sources('packages/host/tauriv2/tests', '.rs'), ...sources('packages/host/tauriv2/src', '.rs'), ...sources('packages/sok/tauriv2/tests', '.rs'), ...sources('packages/sok/tauriv2/src', '.rs')] },
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

/** The declarations of the test sources of one host, read without running them. */
function parseHostSources(name) {
  const { language, files } = HOST_SOURCES[name];
  const tests = [];
  const errors = [];
  for (const file of files()) {
    const parsed = parseDeclarations(readFileSync(join(ROOT, file), 'utf8'), language, file, language === 'rust' ? crateOwnerOf(file) : ownerOfFile(file));
    tests.push(...parsed.tests);
    errors.push(...parsed.errors);
  }
  return { language, tests, errors };
}

/** The static check: the declarations of both hosts agree with the contract cases. It runs no test. */
function checkDeclarations(cases) {
  const hosts = HOSTS.map((name) => ({ name, ...parseHostSources(name) }));
  const { errors, declared } = auditDeclarations(cases, hosts);
  errors.push(...uncoveredCases(cases, declared));
  for (const host of hosts) {
    const required = [...cases.values()].filter((contract) => contract.hosts.includes(host.name)).length;
    process.stdout.write(`${host.name}: ${declared.get(host.name).size} of ${required} contract cases declared; ${host.tests.length} tests\n`);
  }
  if (errors.length > 0) {
    process.stderr.write(`Host contract declarations failed: ${errors.length} issue(s)\n${errors.map((error) => `- ${error}`).join('\n')}\n`);
    return 1;
  }
  process.stdout.write(`Host contract declarations passed: ${cases.size} contract cases\n`);
  return 0;
}

async function main(argv) {
  // The Go link flags start with a dash, so they are given as --go-ldflags=<flags>.
  const { values } = parseArgs({
    args: argv, strict: true,
    options: { 'go-ldflags': { type: 'string' }, run: { type: 'string' }, only: { type: 'string' }, static: { type: 'boolean' } },
  });
  const cases = parseContractCases(readFileSync(join(ROOT, SPEC), 'utf8'));
  // --static checks only the declarations, so it needs no Go link flags and builds nothing.
  if (values.static) return checkDeclarations(cases);
  if (!values['go-ldflags']) throw new Error('usage: check-host-contract.mjs --go-ldflags=<flags> [--run <text>] [--only <text>] | --static');
  const write = (line) => process.stdout.write(`${line}\n`);
  const concurrency = Math.max(2, cpus().length - 2);
  const buildDir = mkdtempSync(join(tmpdir(), 'host-contract-'));
  // Go builds run together; the Rust builds share one cargo lock, so they follow one another. Both languages build at once.
  // A scoped run builds only the runs whose id contains the text of --run.
  if (values.run === '') throw new Error('--run needs a text that the id of a run contains');
  // default: without --run every run builds, because every id contains the empty text.
  const runText = values.run ?? '';
  const goDiscovery = Promise.all(GO_RUNS(values['go-ldflags']).filter((run) => run.id.includes(runText)).map((run) => discoverGo({ ...run, cwd: ROOT, buildDir, write, concurrency, timeoutMs: TEST_TIMEOUT_MS })));
  const rustDiscovery = (async () => {
    const found = [];
    for (const run of RUST_RUNS.filter((entry) => entry.id.includes(runText))) found.push(await discoverRust({ ...run, cwd: ROOT, write, timeoutMs: TEST_TIMEOUT_MS }));
    return found;
  })();
  const [goFound, rustFound] = await Promise.all([goDiscovery, rustDiscovery]);
  const found = { wailsv3: goFound, tauriv2: rustFound };
  // default: without --only every test runs.
  const only = values.only ?? null;
  if (only === '') throw new Error('--only needs a text that the name of a test contains');
  const items = [...goFound, ...rustFound].flatMap((entry) => entry.tests).filter((item) => only === null || item.name.includes(only));
  if (only !== null) {
    // A scoped run shows the tests it ran; the contract audit needs every test, so it belongs to the full run.
    if (items.length === 0) throw new Error(`no test name contains ${JSON.stringify(only)}`);
    write(`RUN  ${items.length} tests with ${concurrency} at once, each limited to ${TEST_TIMEOUT_MS / 1000}s (scoped by ${JSON.stringify(only)}; no contract audit)`);
    const scoped = await runTests({ tests: items, concurrency, write });
    return [...scoped.results.values()].every((result) => result.status === 'pass') ? 0 : 1;
  }
  write(`RUN  ${items.length} tests with ${concurrency} at once, each limited to ${TEST_TIMEOUT_MS / 1000}s`);
  const { results } = await runTests({ tests: items, concurrency, write });
  const hosts = [];
  for (const name of HOSTS) {
    const { language, tests, errors: sourceErrors } = parseHostSources(name);
    const errors = [...found[name].flatMap((entry) => entry.failures), ...sourceErrors];
    const own = found[name].flatMap((entry) => entry.tests);
    for (const item of own) {
      if (results.get(item.name).status === 'timeout') errors.push(`${item.name} exceeded its limit of ${TEST_TIMEOUT_MS / 1000}s`);
    }
    hosts.push({ name, language, tests, errors, items: own, runs: [...groupResults(own, results).values()] });
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

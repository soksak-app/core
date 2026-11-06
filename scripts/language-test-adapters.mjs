import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { cargoCommand } from '@soksak/window-check/cargo.mjs';
import { linkerWarnings } from './macos-minimum.mjs';
import { processWarnings } from './node-warnings.mjs';
import { runCommand } from './test-command.mjs';
import { runWithEvidence, persistEvidence } from './test-evidence.mjs';
import { readNodeTestEvidence, testExecutionErrors, withNodeTestReporters } from './node-test-evidence.mjs';

// The languages that a case may name. Each case declares its own timeoutMs in the manifest. A case of a compiled language also
// declares its build, which runs before the test command under a limit of its own, so the limit of the case measures only the
// tests and a cold build cache does not fail them.
export const SUPPORTED_LANGUAGES = Object.freeze(['js-ts', 'rust', 'go', 'objective-c', 'shell', 'application']);

const supportedLanguages = new Set(SUPPORTED_LANGUAGES);

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_LANGUAGE_TEST_CASES';
  return error;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${name} must be a non-empty string`);
}

function validateTimeout(timeoutMs, name) {
  if (timeoutMs === undefined) throw invalid(`case ${name} has no timeoutMs; each case declares its own limit`);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) throw invalid(`case ${name}.timeoutMs must be an integer from 1 through 600000`);
  return timeoutMs;
}

/** The build of a case: the command that compiles what its test command runs, with its own limit. It runs in the folder of the case. */
function validateBuild(build, id) {
  if (!build || typeof build !== 'object' || Array.isArray(build)) throw invalid(`case ${id}.build must be an object`);
  requireString(build.command, `case ${id}.build.command`);
  if (!Array.isArray(build.args) || build.args.some((arg) => typeof arg !== 'string')) throw invalid(`case ${id}.build.args must be an array of strings`);
  return { command: build.command, args: build.args, timeoutMs: validateTimeout(build.timeoutMs, `${id}.build`) };
}

/** Finds explicit cases in the manifest. It neither infers a case nor drops one silently. */
export function discoverLanguageCases(manifest) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw invalid('manifest.cases must contain at least one case');
  }
  const seen = new Set();
  return manifest.cases.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw invalid(`case ${index} must be an object`);
    requireString(entry.id, `case ${index}.id`);
    if (seen.has(entry.id)) throw invalid(`duplicate case id: ${entry.id}`);
    seen.add(entry.id);
    requireString(entry.language, `case ${entry.id}.language`);
    if (!supportedLanguages.has(entry.language)) throw invalid(`unsupported language: ${entry.language}`);
    requireString(entry.command, `case ${entry.id}.command`);
    if (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== 'string')) throw invalid(`case ${entry.id}.args must be an array of strings`);
    if (entry.cwd !== undefined) requireString(entry.cwd, `case ${entry.id}.cwd`);
    const expectedStatus = entry.expectedStatus ?? 'pass';
    if (expectedStatus !== 'pass') throw invalid(`case ${entry.id}.expectedStatus must be pass`);
    return {
      id: entry.id,
      language: entry.language,
      command: entry.command,
      args: entry.args,
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
      timeoutMs: validateTimeout(entry.timeoutMs, entry.id),
      ...(entry.build === undefined ? {} : { build: validateBuild(entry.build, entry.id) }),
      expectedTests: entry.expectedTests,
      ...(entry.implementationFiles === undefined ? {} : { implementationFiles: entry.implementationFiles }),
      ...(entry.testFiles === undefined ? {} : { testFiles: entry.testFiles }),
      ...(entry.dependencyFiles === undefined ? {} : { dependencyFiles: entry.dependencyFiles }),
      ...(entry.buildFlags === undefined ? {} : { buildFlags: entry.buildFlags }),
    };
  });
}

function parseRust(output) {
  const actual = { tests: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
  for (const result of output.matchAll(/test result: .*? (\d+) passed; (\d+) failed; (\d+) ignored;/g)) {
    actual.tests += Number(result[1]) + Number(result[2]);
    actual.failed += Number(result[2]);
    actual.skipped += Number(result[3]);
  }
  return actual;
}

function parseGo(output) {
  let tests = 0;
  let failed = 0;
  let skipped = 0;
  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line);
      // A package without test files emits output followed by package skip; it is not a skipped named test.
      if (!event.Test) continue;
      if (event.Action === 'pass' || event.Action === 'fail') tests++;
      if (event.Action === 'fail') failed++;
      if (event.Action === 'skip') skipped++;
    } catch {
      // go test -json permits compiler and tool text. The command result still remains visible.
    }
  }
  return { tests, failed, skipped, cancelled: 0, todo: 0 };
}

function parseObjectiveC(output) {
  const passed = output.match(/\bPASS:/g) ?? [];
  const failed = output.match(/\bFAIL:/g) ?? [];
  return { tests: passed.length + failed.length, failed: failed.length, skipped: 0, cancelled: 0, todo: 0 };
}

function parseShell(output) {
  const results = [];
  for (const line of output.split('\n')) {
    const marker = line.match(/^(PASS|FAIL|SKIP|CANCEL|TODO):/);
    if (!marker) continue;
    results.push(/^((PASS|FAIL|SKIP|CANCEL|TODO):)\s+\S.*$/.test(line) ? marker[1] : 'FAIL');
  }
  return {
    tests: results.filter((result) => result === 'PASS' || result === 'FAIL').length,
    failed: results.filter((result) => result === 'FAIL').length,
    skipped: results.filter((result) => result === 'SKIP').length,
    cancelled: results.filter((result) => result === 'CANCEL').length,
    todo: results.filter((result) => result === 'TODO').length,
  };
}

export function parseLanguageResult(language, stdout, stderr) {
  const output = `${stdout}\n${stderr}`;
  if (language === 'js-ts') return readNodeTestEvidence(output).actual;
  if (language === 'rust') return parseRust(output);
  if (language === 'go') return parseGo(output);
  if (language === 'objective-c') return parseObjectiveC(output);
  if (language === 'shell') return parseShell(output);
  throw invalid(`unsupported language: ${language}`);
}

// A case that names cargo runs the cargo that cargoCommand resolves, as every script of the repository does.
const executable = (command) => (command === 'cargo' ? cargoCommand() : command);

/** The result of the build of a case. Its link output is judged as the output of the case is (macos-minimum.mjs). */
function buildResult(commandResult) {
  const errors = [];
  if (commandResult.status !== 'pass') errors.push(`build status ${commandResult.status}`);
  errors.push(...linkerWarnings(`${commandResult.stdout}\n${commandResult.stderr}`).failures);
  errors.push(...processWarnings(`${commandResult.stdout}\n${commandResult.stderr}`));
  return {
    status: commandResult.status === 'pass' && errors.length > 0 ? 'fail' : commandResult.status,
    exitCode: commandResult.exitCode,
    signal: commandResult.signal,
    elapsedMs: commandResult.elapsedMs,
    errors,
  };
}

/** The result of a case whose build failed: its test command does not run, so no test is counted. */
function unbuiltResult(caseSpec, build) {
  return {
    id: caseSpec.id,
    language: caseSpec.language,
    status: 'fail',
    expected: { status: 'pass', ...(caseSpec.expectedTests === undefined ? {} : { tests: caseSpec.expectedTests }) },
    build,
    actual: { status: 'not-run', signal: null, tests: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0 },
    elapsedMs: 0,
    stdout: '',
    stderr: '',
    errors: [...build.errors, 'the build failed, so no test ran'],
  };
}

function caseResult(caseSpec, build, commandResult) {
  const nodeEvidence = caseSpec.language === 'js-ts' ? readNodeTestEvidence(`${commandResult.stdout}\n${commandResult.stderr}`,
    (caseSpec.testFiles ?? []).map((file) => resolve(caseSpec.cwd ?? process.cwd(), file))) : null;
  const actual = nodeEvidence?.actual ?? parseLanguageResult(caseSpec.language, commandResult.stdout, commandResult.stderr);
  const errors = nodeEvidence?.errors ?? testExecutionErrors(actual);
  if (commandResult.status !== 'pass') errors.push(`command status ${commandResult.status}`);
  if (commandResult.signal) errors.push(`process crashed with ${commandResult.signal}`);
  // A build of the case whose link reports an object newer than the link compiled or linked for another macOS version (macos-minimum.mjs).
  errors.push(...linkerWarnings(`${commandResult.stdout}\n${commandResult.stderr}`).failures);
  errors.push(...processWarnings(`${commandResult.stdout}\n${commandResult.stderr}`));
  if (caseSpec.expectedTests !== undefined && actual.tests !== caseSpec.expectedTests) {
    errors.push(`expected ${caseSpec.expectedTests} tests, observed ${actual.tests}`);
  }
  return {
    id: caseSpec.id,
    language: caseSpec.language,
    status: errors.length === 0 ? 'pass' : 'fail',
    expected: { status: 'pass', ...(caseSpec.expectedTests === undefined ? {} : { tests: caseSpec.expectedTests }) },
    build,
    actual: { status: commandResult.status, signal: commandResult.signal, ...actual },
    elapsedMs: commandResult.elapsedMs,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    errors,
  };
}

export async function runLanguageCases(cases, { onEvent, evidence = false, root } = {}) {
  if (!Array.isArray(cases) || cases.length === 0) throw invalid('at least one discovered case is required');
  const results = [];
  for (const caseSpec of cases) {
    const report = (phase) => (event) => onEvent?.({ ...event, phase, language: caseSpec.language, caseId: caseSpec.id });
    const execute = async () => {
      let build = null;
      if (caseSpec.build) {
        build = buildResult(await runCommand({
          id: caseSpec.id, command: executable(caseSpec.build.command), args: caseSpec.build.args, cwd: caseSpec.cwd,
          timeoutMs: caseSpec.build.timeoutMs, onEvent: report('build'),
        }));
        if (build.status !== 'pass') return unbuiltResult(caseSpec, build);
      }
      return caseResult(caseSpec, build, await runCommand({
        id: caseSpec.id,
        command: caseSpec.language === 'js-ts' ? '/usr/bin/env' : executable(caseSpec.command),
        args: caseSpec.language === 'js-ts' ? ['-u', 'NODE_TEST_CONTEXT', caseSpec.command, ...withNodeTestReporters(caseSpec.args)] : caseSpec.args,
        cwd: caseSpec.cwd,
        timeoutMs: caseSpec.timeoutMs,
        onEvent: report('test'),
      }));
    };
    const result = evidence ? await runWithEvidence({
        root,
        caseId: caseSpec.id,
        language: caseSpec.language,
        implementationFiles: caseSpec.implementationFiles,
        testFiles: caseSpec.testFiles,
        dependencyFiles: caseSpec.dependencyFiles,
        buildFlags: caseSpec.buildFlags,
        processes: [],
      }, execute) : await execute();
    results.push(result);
  }
  return {
    status: results.every((result) => result.status === 'pass') ? 'pass' : 'fail',
    cases: results,
  };
}

export async function readLanguageCaseManifest(path) {
  const source = await readFile(path, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    error.code = 'INVALID_LANGUAGE_TEST_MANIFEST';
    throw error;
  }
  return discoverLanguageCases(manifest);
}

function parseCli(argv) {
  let evidenceFile;
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--evidence-file') {
      if (!argv[index + 1]) throw new Error('--evidence-file requires a path');
      evidenceFile = argv[++index];
    } else positional.push(argv[index]);
  }
  if (positional.length !== 1) throw new Error('usage: node scripts/language-test-adapters.mjs [--evidence-file PATH] MANIFEST.json');
  return { manifestPath: positional[0], evidenceFile };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const { manifestPath, evidenceFile } = parseCli(process.argv.slice(2));
      const cases = await readLanguageCaseManifest(manifestPath);
      const result = await runLanguageCases(cases, { evidence: true, onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) });
      if (evidenceFile) await persistEvidence(evidenceFile, result.cases.map(({ evidence: record }) => record));
      process.stdout.write(`${JSON.stringify({ type: 'suite-final', status: result.status, evidenceFile: evidenceFile ?? null, cases: result.cases.map(({ id, language, status, expected, build, actual, elapsedMs, errors, evidence: record }) => ({ id, language, status, expected, build, actual, elapsedMs, errors, evidence: record ? { git: record.git, implementation: record.implementation, tests: record.tests, dependencies: record.dependencies, buildFlags: record.buildFlags, processes: record.processes, attempts: record.attempts } : null })) })}\n`);
      process.exitCode = result.status === 'pass' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.code ?? 'LANGUAGE_TEST_ERROR'}: ${error.message}\n`);
    process.exitCode = 2;
  }
}

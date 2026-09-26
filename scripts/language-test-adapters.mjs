import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runCommand } from './test-command.mjs';
import { collectEvidence, persistEvidence } from './test-evidence.mjs';

export const DEFAULT_TIMEOUT_MS = Object.freeze({
  'js-ts': 10_000,
  rust: 30_000,
  go: 30_000,
  'objective-c': 30_000,
  shell: 30_000,
  application: 60_000,
});

const supportedLanguages = new Set(Object.keys(DEFAULT_TIMEOUT_MS));

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_LANGUAGE_TEST_CASES';
  return error;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${name} must be a non-empty string`);
}

function validateTimeout(timeoutMs, language) {
  const value = timeoutMs ?? DEFAULT_TIMEOUT_MS[language];
  if (!Number.isInteger(value) || value <= 0 || value > 600_000) throw invalid(`timeoutMs for ${language} must be an integer from 1 through 600000`);
  return value;
}

/** Discover explicit cases from a manifest. No case is inferred or silently dropped. */
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
      timeoutMs: validateTimeout(entry.timeoutMs, entry.language),
      expectedTests: entry.expectedTests,
      ...(entry.implementationFiles === undefined ? {} : { implementationFiles: entry.implementationFiles }),
      ...(entry.testFiles === undefined ? {} : { testFiles: entry.testFiles }),
      ...(entry.dependencyFiles === undefined ? {} : { dependencyFiles: entry.dependencyFiles }),
      ...(entry.buildFlags === undefined ? {} : { buildFlags: entry.buildFlags }),
    };
  });
}

function numberFrom(output, expression, fallback = 0) {
  const match = output.match(expression);
  return match ? Number(match[1]) : fallback;
}

function parseNode(output) {
  return {
    tests: numberFrom(output, /^(?:#|ℹ) tests (\d+)$/m),
    failed: numberFrom(output, /^(?:#|ℹ) fail (\d+)$/m),
    skipped: numberFrom(output, /^(?:#|ℹ) skipped (\d+)$/m),
    cancelled: numberFrom(output, /^(?:#|ℹ) cancelled (\d+)$/m),
    todo: numberFrom(output, /^(?:#|ℹ) todo (\d+)$/m),
  };
}

function parseRust(output) {
  const result = [...output.matchAll(/test result: .*? (\d+) passed; (\d+) failed; (\d+) ignored;/g)].at(-1);
  if (!result) return { tests: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
  return { tests: Number(result[1]), failed: Number(result[2]), skipped: Number(result[3]), cancelled: 0, todo: 0 };
}

function parseGo(output) {
  let tests = 0;
  let failed = 0;
  let skipped = 0;
  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (!event.Test) {
        if (event.Action === 'skip' && String(event.Output ?? '').includes('[no test files]')) skipped++;
        continue;
      }
      if (event.Action === 'pass') tests++;
      if (event.Action === 'fail') failed++;
      if (event.Action === 'skip') skipped++;
    } catch {
      // go test -json permits compiler and tool text; the command result still remains visible.
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
  if (language === 'js-ts') return parseNode(output);
  if (language === 'rust') return parseRust(output);
  if (language === 'go') return parseGo(output);
  if (language === 'objective-c') return parseObjectiveC(output);
  if (language === 'shell') return parseShell(output);
  throw invalid(`unsupported language: ${language}`);
}

function caseResult(caseSpec, commandResult) {
  const actual = parseLanguageResult(caseSpec.language, commandResult.stdout, commandResult.stderr);
  const errors = [];
  if (commandResult.status !== 'pass') errors.push(`command status ${commandResult.status}`);
  if (commandResult.signal) errors.push(`process crashed with ${commandResult.signal}`);
  if (actual.tests === 0) errors.push('zero tests reported');
  if (actual.failed > 0) errors.push(`${actual.failed} test(s) failed`);
  if (actual.skipped > 0) errors.push(`${actual.skipped} test(s) skipped`);
  if (actual.cancelled > 0) errors.push(`${actual.cancelled} test(s) cancelled`);
  if (actual.todo > 0) errors.push(`${actual.todo} test(s) marked todo`);
  if (caseSpec.expectedTests !== undefined && actual.tests !== caseSpec.expectedTests) {
    errors.push(`expected ${caseSpec.expectedTests} tests, observed ${actual.tests}`);
  }
  return {
    id: caseSpec.id,
    language: caseSpec.language,
    status: errors.length === 0 ? 'pass' : 'fail',
    expected: { status: 'pass', ...(caseSpec.expectedTests === undefined ? {} : { tests: caseSpec.expectedTests }) },
    actual: { status: commandResult.status, signal: commandResult.signal, ...actual },
    elapsedMs: commandResult.elapsedMs,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    errors,
  };
}

export async function runLanguageCases(cases, { onEvent, evidence = false } = {}) {
  if (!Array.isArray(cases) || cases.length === 0) throw invalid('at least one discovered case is required');
  const results = [];
  for (const caseSpec of cases) {
    const commandResult = await runCommand({
      id: caseSpec.id,
      command: caseSpec.command,
      args: caseSpec.args,
      cwd: caseSpec.cwd,
      timeoutMs: caseSpec.timeoutMs,
      onEvent: (event) => onEvent?.({ ...event, language: caseSpec.language, caseId: caseSpec.id }),
    });
    const result = caseResult(caseSpec, commandResult);
    if (evidence) {
      result.evidence = await collectEvidence({
        caseId: caseSpec.id,
        language: caseSpec.language,
        implementationFiles: caseSpec.implementationFiles,
        testFiles: caseSpec.testFiles,
        dependencyFiles: caseSpec.dependencyFiles,
        buildFlags: caseSpec.buildFlags,
        processes: [],
        result,
      });
    }
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
      process.stdout.write(`${JSON.stringify({ type: 'suite-final', status: result.status, evidenceFile: evidenceFile ?? null, cases: result.cases.map(({ id, language, status, expected, actual, elapsedMs, errors, evidence: record }) => ({ id, language, status, expected, actual, elapsedMs, errors, evidence: record ? { git: record.git, implementation: record.implementation, tests: record.tests, dependencies: record.dependencies, buildFlags: record.buildFlags, processes: record.processes, attempts: record.attempts } : null })) })}\n`);
      process.exitCode = result.status === 'pass' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.code ?? 'LANGUAGE_TEST_ERROR'}: ${error.message}\n`);
    process.exitCode = 2;
  }
}

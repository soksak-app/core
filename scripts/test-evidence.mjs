import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const EVIDENCE_SCHEMA = 1;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ALLOWED_STATUSES = new Set(['pass', 'fail', 'timeout', 'cancelled']);

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_TEST_EVIDENCE';
  return error;
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${name} must be a non-empty string`);
}

function requiredArray(value, name) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw invalid(`${name} must be an array of strings`);
}

function requiredDigest(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw invalid(`${name} must be a SHA-256 digest`);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function hashFile(root, file) {
  requiredText(file, 'file');
  const path = resolve(root, file);
  const content = await readFile(path);
  return { path: file, sha256: digest(content) };
}

async function hashFiles(root, files, name) {
  requiredArray(files, name);
  if (new Set(files).size !== files.length) throw invalid(`${name} must not contain duplicate files`);
  const entries = [];
  for (const file of [...files].sort()) entries.push(await hashFile(root, file));
  return { files: entries, sha256: digest(JSON.stringify(entries)) };
}

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  } catch (error) {
    error.code = error.code ?? 'GIT_EVIDENCE_ERROR';
    throw error;
  }
}

// git 출력의 SHA-256. 출력을 버퍼에 모으지 않으므로 큰 바이너리 patch 도 크기 한도 없이 해시한다.
function gitDigest(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const hash = createHash('sha256');
    let stderr = '';
    child.stdout.on('data', (chunk) => hash.update(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      error.code = error.code ?? 'GIT_EVIDENCE_ERROR';
      reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) return resolve(hash.digest('hex'));
      const error = new Error(`git ${args.join(' ')} failed with exit ${code}: ${stderr.trim()}`);
      error.code = 'GIT_EVIDENCE_ERROR';
      reject(error);
    });
  });
}

async function dirtyState(root) {
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const files = [];
  for (const line of status.split('\n').filter(Boolean)) {
    const state = line.slice(0, 2);
    const path = line.slice(3);
    try {
      files.push({ state, path, ...(await hashFile(root, path)) });
    } catch (error) {
      if (state.includes('D')) files.push({ state, path, sha256: null });
      else throw error;
    }
  }
  const patchSha256 = await gitDigest(root, ['diff', '--binary', 'HEAD']);
  return {
    head: git(root, ['rev-parse', 'HEAD']).trim(),
    files,
    patchSha256,
    sha256: digest(JSON.stringify({ files, patchSha256 })),
  };
}

async function runningProcess(root, entry) {
  if (!entry || typeof entry !== 'object' || !Number.isInteger(entry.pid) || entry.pid <= 0) throw invalid('process.pid must be a positive integer');
  requiredText(entry.executable, `process ${entry.pid}.executable`);
  try {
    process.kill(entry.pid, 0);
  } catch (error) {
    throw new Error(`process ${entry.pid} is not running: ${error.code ?? error.message}`);
  }
  const executable = await realpath(resolve(root, entry.executable));
  const relative = executable.startsWith(`${resolve(root)}/`) ? executable.slice(resolve(root).length + 1) : executable;
  const file = await hashFile(root, relative);
  return { pid: entry.pid, executable: relative, sha256: file.sha256 };
}

function resultShape(result) {
  if (!result || typeof result !== 'object') throw invalid('result is required');
  requiredText(result.status, 'result.status');
  if (!ALLOWED_STATUSES.has(result.status)) throw invalid(`unsupported result status: ${result.status}`);
  if (!Number.isFinite(result.elapsedMs) || result.elapsedMs < 0) throw invalid('result.elapsedMs must be non-negative');
  if (result.expected === undefined || result.actual === undefined) throw invalid('result.expected and result.actual are required');
  return { status: result.status, expected: result.expected, actual: result.actual, elapsedMs: result.elapsedMs };
}

function immutablePart(record) {
  return {
    schema: record.schema,
    caseId: record.caseId,
    language: record.language,
    git: record.git,
    implementation: record.implementation,
    tests: record.tests,
    dependencies: record.dependencies,
    buildFlags: record.buildFlags,
    processes: record.processes,
  };
}

export async function collectEvidence({ root = ROOT, caseId, language, implementationFiles, testFiles, dependencyFiles, buildFlags, processes = [], result }) {
  requiredText(caseId, 'caseId');
  requiredText(language, 'language');
  requiredArray(buildFlags, 'buildFlags');
  if (!Array.isArray(processes)) throw invalid('processes must be an array');
  const immutable = {
    schema: EVIDENCE_SCHEMA,
    caseId,
    language,
    git: await dirtyState(root),
    implementation: await hashFiles(root, implementationFiles, 'implementationFiles'),
    tests: await hashFiles(root, testFiles, 'testFiles'),
    dependencies: await hashFiles(root, dependencyFiles, 'dependencyFiles'),
    buildFlags: [...buildFlags],
    processes: await Promise.all(processes.map((entry) => runningProcess(root, entry))),
  };
  const shaped = resultShape(result);
  return { ...immutable, result: shaped, attempts: [{ number: 1, ...shaped }] };
}

export function appendEvidenceAttempt(record, result) {
  if (!record || typeof record !== 'object' || record.schema !== EVIDENCE_SCHEMA || !Array.isArray(record.attempts) || record.attempts.length === 0) throw invalid('record has no initial evidence attempt');
  const shaped = resultShape(result);
  const number = record.attempts.length + 1;
  return { ...record, result: shaped, attempts: [...record.attempts, { number, ...shaped }] };
}

export function evidenceDrift(record, current) {
  if (!record || !current) throw invalid('record and current evidence are required');
  const expected = JSON.stringify(immutablePart(record));
  const actual = JSON.stringify(immutablePart(current));
  return expected === actual ? [] : ['evidence snapshot is stale: source, test, dependency, build, process, or dirty-worktree content changed'];
}

export function validateEvidence(record) {
  const errors = [];
  try {
    if (!record || record.schema !== EVIDENCE_SCHEMA) throw invalid('unsupported evidence schema');
    requiredText(record.caseId, 'caseId');
    requiredText(record.language, 'language');
    if (!/^[0-9a-f]{40}$/.test(record.git?.head ?? '')) throw invalid('git.head must be a commit id');
    requiredDigest(record.git.sha256, 'git.sha256');
    requiredDigest(record.git.patchSha256, 'git.patchSha256');
    if (!Array.isArray(record.git.files)) throw invalid('git.files must be an array');
    for (const entry of record.git.files) {
      requiredText(entry?.state, 'git file state');
      requiredText(entry?.path, 'git file path');
      if (entry.sha256 !== null) requiredDigest(entry.sha256, `git file ${entry.path}.sha256`);
    }
    for (const [name, value] of [['implementation', record.implementation], ['tests', record.tests], ['dependencies', record.dependencies]]) {
      if (!value || !Array.isArray(value.files)) throw invalid(`${name}.files must be an array`);
      for (const entry of value.files) {
        requiredText(entry?.path, `${name} file path`);
        requiredDigest(entry?.sha256, `${name} file ${entry.path}.sha256`);
      }
      requiredDigest(value.sha256, `${name}.sha256`);
    }
    requiredArray(record.buildFlags, 'buildFlags');
    if (!Array.isArray(record.processes)) throw invalid('processes must be an array');
    for (const entry of record.processes) {
      if (!Number.isInteger(entry?.pid) || entry.pid <= 0) throw invalid('process.pid must be a positive integer');
      requiredText(entry.executable, `process ${entry.pid}.executable`);
      requiredDigest(entry.sha256, `process ${entry.pid}.sha256`);
    }
    if (!Array.isArray(record.attempts) || record.attempts.length === 0) throw invalid('initial attempt is missing');
    record.attempts.forEach((attempt, index) => {
      if (attempt.number !== index + 1) throw invalid(`attempt numbering is not contiguous at ${index + 1}`);
      resultShape(attempt);
    });
    if (JSON.stringify(record.result) !== JSON.stringify(record.attempts.at(-1))) {
      // 결과는 시도 번호를 뺀 최신 결과다. 그 필드를 명시적으로 비교한다.
      const latest = record.attempts.at(-1);
      if (record.result.status !== latest.status || record.result.elapsedMs !== latest.elapsedMs || JSON.stringify(record.result.expected) !== JSON.stringify(latest.expected) || JSON.stringify(record.result.actual) !== JSON.stringify(latest.actual)) throw invalid('latest result does not match the attempt history');
    }
  } catch (error) {
    errors.push(error.message);
  }
  return errors;
}

export async function persistEvidence(path, records) {
  if (!Array.isArray(records) || records.length === 0) throw invalid('records must contain at least one evidence record');
  const existing = await readFile(path, 'utf8').then((source) => JSON.parse(source)).catch((error) => {
    if (error.code === 'ENOENT') return { schema: EVIDENCE_SCHEMA, cases: {} };
    throw error;
  });
  if (existing.schema !== EVIDENCE_SCHEMA || !existing.cases || typeof existing.cases !== 'object' || Array.isArray(existing.cases)) throw invalid('evidence file schema is invalid');
  const next = { schema: EVIDENCE_SCHEMA, cases: { ...existing.cases } };
  for (const record of records) {
    const errors = validateEvidence(record);
    if (errors.length) throw invalid(`${record.caseId}: ${errors.join('; ')}`);
    const prior = next.cases[record.caseId];
    if (!prior) next.cases[record.caseId] = record;
    else {
      const drift = evidenceDrift(prior, record);
      if (drift.length) throw invalid(`${record.caseId}: ${drift.join('; ')}`);
      next.cases[record.caseId] = appendEvidenceAttempt(prior, record.result);
    }
  }
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return next;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.stderr.write(`${basename(process.argv[1])} is a library; use collectEvidence or appendEvidenceAttempt from a declared test command\n`);
  process.exitCode = 2;
}

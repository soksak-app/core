import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendEvidenceAttempt, collectEvidence, evidenceDrift, persistEvidence, validateEvidence } from '../test-evidence.mjs';
import * as evidence from '../test-evidence.mjs';
import { processExecutable } from '../platform/darwin/process-executable.mjs';

async function inputFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'soksak-evidence-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'evidence@example.invalid');
  git('config', 'user.name', 'evidence');
  for (const file of ['source.mjs', 'source.test.mjs', 'dependency.json']) await writeFile(join(root, file), 'original\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  return { root, caseId: 'input-binding', language: 'js-ts', implementationFiles: ['source.mjs'],
    testFiles: ['source.test.mjs'], dependencyFiles: ['dependency.json'], buildFlags: ['--test'] };
}

test('process evidence rejects a live PID paired with an unrelated file', { timeout: 10000 }, async (t) => {
  const options = await inputFixture(t);
  await assert.rejects(() => collectEvidence({ ...options,
    processes: [{ pid: process.pid, executable: 'source.mjs' }],
    result: { status: 'pass', expected: 1, actual: 1, elapsedMs: 1 } }), /executable mismatch/);
});

test('process evidence rejects an unavailable or exited process identity', { timeout: 10000 }, async () => {
  const entry = { pid: process.pid, executable: process.execPath };
  await assert.rejects(() => evidence.runningProcess(process.cwd(), entry, {
    readExecutable: async () => { throw new Error('identity unavailable'); },
  }), /identity unavailable/);
  await assert.rejects(() => evidence.runningProcess(process.cwd(), { ...entry, pid: 99999999 }), /not running/);
  await assert.rejects(() => evidence.runningProcess(process.cwd(), entry, { readExecutable: async () => '' }), /identity.*unavailable/);
});

test('process identity preserves whitespace belonging to the executable path', { timeout: 10000 }, async () => {
  assert.equal(await processExecutable(process.pid, { execute: async () => ({ stdout: '/candidate/program \n' }) }), '/candidate/program ');
});

for (const [file, name] of [
  [null, 'executed evidence binds unchanged inputs before the command'],
  ['source.mjs', 'executed evidence binds source.mjs before the command'],
  ['source.test.mjs', 'executed evidence binds source.test.mjs before the command'],
  ['dependency.json', 'executed evidence binds dependency.json before the command'],
]) {
  test(name, { timeout: 10000 }, async (t) => {
    const options = await inputFixture(t);
    const original = await collectEvidence({ ...options, result: { status: 'pass', expected: 1, actual: 1, elapsedMs: 1 } });
    const result = await evidence.runWithEvidence(options, async () => {
      if (file) await writeFile(join(options.root, file), 'changed after the assertion\n');
      return { status: 'pass', expected: 1, actual: 1, elapsedMs: 2, errors: [], stdout: 'passed', stderr: '' };
    });
    assert.equal(result.status, file ? 'fail' : 'pass');
    assert.deepEqual(result.evidence.implementation, original.implementation, 'the result must retain the implementation present before execution');
    assert.deepEqual(result.evidence.tests, original.tests);
    assert.deepEqual(result.evidence.dependencies, original.dependencies);
    assert.equal(result.evidence.commandResult.status, 'pass', 'input drift must not replace the actual command outcome');
    assert.equal(validateEvidence(result.evidence).length, 0);
    if (file) assert.match(result.errors.join('\n'), /inputs changed during execution/);
  });
}

test('executed evidence preserves a failed command and reports an input that disappears', { timeout: 10000 }, async (t) => {
  const options = await inputFixture(t);
  const result = await evidence.runWithEvidence(options, async () => {
    await rm(join(options.root, 'source.mjs'));
    return { status: 'fail', expected: 1, actual: 0, elapsedMs: 2, errors: ['assertion failed'], stdout: '', stderr: 'failure detail' };
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.stderr, 'failure detail');
  assert.equal(result.evidence.commandResult.actual, 0);
  assert.ok(result.errors.includes('assertion failed'));
  assert.match(result.errors.join('\n'), /cannot verify inputs after execution/);
  assert.equal(result.evidence.implementation.files.length, 1);
});

test('executed evidence retains failure output when the inputs are unchanged', { timeout: 10000 }, async (t) => {
  const options = await inputFixture(t);
  const failure = { status: 'fail', expected: 1, actual: 0, elapsedMs: 2, errors: ['assertion failed'], stdout: '', stderr: 'failure detail' };
  const result = await evidence.runWithEvidence(options, async () => failure);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.errors, ['assertion failed']);
  assert.deepEqual(result.evidence.inputErrors, []);
  assert.equal(result.evidence.commandResult.status, 'fail');
  assert.equal(result.stderr, failure.stderr);
});

test('executed evidence refuses changed build options', { timeout: 10000 }, async (t) => {
  const options = await inputFixture(t);
  const result = await evidence.runWithEvidence(options, async () => {
    options.buildFlags.push('--changed');
    return { status: 'pass', expected: 1, actual: 1, elapsedMs: 2 };
  });
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.evidence.buildFlags, ['--test']);
  assert.match(result.errors.join('\n'), /inputs changed during execution/);
});

test('persisted execution attempts retain each command outcome and input error', { timeout: 10000 }, async (t) => {
  const options = await inputFixture(t);
  const first = await evidence.runWithEvidence(options, async () => ({ status: 'fail', expected: 1, actual: 0, elapsedMs: 1 }));
  const second = await evidence.runWithEvidence(options, async () => ({ status: 'pass', expected: 1, actual: 1, elapsedMs: 2 }));
  const output = await mkdtemp(join(tmpdir(), 'soksak-evidence-attempts-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const path = join(output, 'evidence.json');
  await persistEvidence(path, [first.evidence]);
  await persistEvidence(path, [second.evidence]);
  const record = JSON.parse(await readFile(path, 'utf8')).cases[options.caseId];
  assert.deepEqual(record.attempts.map((attempt) => attempt.commandResult?.status), ['fail', 'pass']);
  assert.deepEqual(record.attempts.map((attempt) => attempt.inputErrors), [[], []]);
  assert.deepEqual(validateEvidence(record), []);
  assert.throws(() => appendEvidenceAttempt(first.evidence, second.evidence.result), /execution-bound/);
  const stale = structuredClone(record);
  stale.commandResult = first.evidence.commandResult;
  assert.match(validateEvidence(stale).join('\n'), /command outcome|latest execution/);
  const omitted = structuredClone(record);
  delete omitted.commandResult;
  delete omitted.inputErrors;
  assert.match(validateEvidence(omitted).join('\n'), /latest execution/);
});

test('evidence records content hashes, dirty state, expected/actual result, and retry history', async (t) => {
  // A repository of the test: the dirty state of the checkout that runs the test, such as untracked logs, is not an input.
  const repo = await mkdtemp(join(tmpdir(), 'soksak-evidence-repo-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  run('init', '-q');
  run('config', 'user.email', 'evidence@example.invalid');
  run('config', 'user.name', 'evidence');
  await writeFile(join(repo, 'source.mjs'), 'export const value = 1;\n');
  await writeFile(join(repo, 'source.test.mjs'), 'import "./source.mjs";\n');
  await writeFile(join(repo, 'package.json'), '{}\n');
  run('add', '.');
  run('commit', '-q', '-m', 'initial');
  await writeFile(join(repo, 'source.mjs'), 'export const value = 2;\n');
  const record = await collectEvidence({
    root: repo,
    caseId: 'evidence-self-test', language: 'js-ts',
    implementationFiles: ['source.mjs'],
    testFiles: ['source.test.mjs'],
    dependencyFiles: ['package.json'], buildFlags: ['node>=20'], processes: [{ pid: process.pid, executable: process.execPath }],
    result: { status: 'fail', expected: { status: 'pass', tests: 1 }, actual: { status: 'fail', tests: 0 }, elapsedMs: 4 },
  });
  assert.equal(validateEvidence(record).length, 0);
  const retried = appendEvidenceAttempt(record, { status: 'pass', expected: { status: 'pass', tests: 1 }, actual: { status: 'pass', tests: 1 }, elapsedMs: 6 });
  assert.deepEqual(retried.attempts.map(({ number, status }) => [number, status]), [[1, 'fail'], [2, 'pass']]);
  assert.equal(validateEvidence(retried).length, 0);
  assert.equal(retried.git.head.length, 40);
  assert.match(retried.implementation.sha256, /^[0-9a-f]{64}$/);
  assert.ok(retried.git.sha256);
  assert.deepEqual(retried.git.files.map(({ state, path }) => [state, path]), [[' M', 'source.mjs']]);
  assert.equal(retried.processes.length, 1);
  assert.match(retried.processes[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(evidenceDrift(retried, { ...retried, buildFlags: ['different'] }), ['evidence snapshot is stale: source, test, dependency, build, process, or dirty-worktree content changed']);
  assert.deepEqual(evidenceDrift(retried, { ...retried, processes: [{ ...retried.processes[0], sha256: '0'.repeat(64) }] }), ['evidence snapshot is stale: source, test, dependency, build, process, or dirty-worktree content changed']);
  const evidenceDirectory = await mkdtemp(join(tmpdir(), 'soksak-evidence-file-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const evidenceFile = join(evidenceDirectory, 'evidence.json');
  await persistEvidence(evidenceFile, [record]);
  await persistEvidence(evidenceFile, [retried]);
  const persisted = JSON.parse(await readFile(evidenceFile, 'utf8'));
  assert.deepEqual(persisted.cases['evidence-self-test'].attempts.map(({ number, status }) => [number, status]), [[1, 'fail'], [2, 'pass']]);
  await assert.rejects(
    () => collectEvidence({
      root: repo,
      caseId: 'missing-process', language: 'js-ts',
      implementationFiles: ['source.mjs'],
      testFiles: ['source.test.mjs'],
      dependencyFiles: ['package.json'], buildFlags: ['node>=20'],
      processes: [{ pid: 99999999, executable: process.execPath }],
      result: { status: 'pass', expected: 1, actual: 1, elapsedMs: 1 },
    }),
    /is not running/,
  );
});

test('evidence rejects missing initial failure history and non-contiguous retries', () => {
  const base = {
    schema: 1, caseId: 'x', language: 'go',
    git: { head: 'a'.repeat(40), sha256: 'b'.repeat(64), patchSha256: 'c'.repeat(64), files: [] },
    implementation: { files: [], sha256: 'd'.repeat(64) },
    tests: { files: [], sha256: 'e'.repeat(64) },
    dependencies: { files: [], sha256: 'f'.repeat(64) },
    buildFlags: [], processes: [],
    result: { status: 'pass', expected: {}, actual: {}, elapsedMs: 1 },
    attempts: [{ number: 2, status: 'pass', expected: {}, actual: {}, elapsedMs: 1 }],
  };
  assert.match(validateEvidence(base).join('\n'), /not contiguous/);
});

test('evidence is recorded for a worktree with a multi-megabyte binary change', { timeout: 30000 }, async () => {
  const { randomBytes } = await import('node:crypto');
  const repo = await mkdtemp(join(tmpdir(), 'soksak-evidence-large-'));
  try {
    const run = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    run('init', '-q');
    run('config', 'user.email', 'evidence@example.invalid');
    run('config', 'user.name', 'evidence');
    await writeFile(join(repo, 'large.bin'), randomBytes(4 * 1024 * 1024));
    await writeFile(join(repo, 'source.mjs'), 'export const value = 1;\n');
    run('add', '.');
    run('commit', '-q', '-m', 'initial');
    await writeFile(join(repo, 'large.bin'), randomBytes(4 * 1024 * 1024));
    const record = await collectEvidence({
      root: repo,
      caseId: 'large-binary-change', language: 'js-ts',
      implementationFiles: ['source.mjs'], testFiles: ['source.mjs'], dependencyFiles: ['source.mjs'],
      buildFlags: ['node>=20'],
      result: { status: 'pass', expected: { status: 'pass', tests: 1 }, actual: { status: 'pass', tests: 1 }, elapsedMs: 1 },
    });
    assert.equal(validateEvidence(record).length, 0);
    assert.match(record.git.patchSha256, /^[0-9a-f]{64}$/);
    assert.ok(record.git.files.some(({ path }) => path === 'large.bin'));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('evidence records a renamed path and a path that git status quotes', { timeout: 30000 }, async () => {
  const repo = await mkdtemp(join(tmpdir(), 'soksak-evidence-rename-'));
  try {
    const run = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    run('init', '-q');
    run('config', 'user.email', 'evidence@example.invalid');
    run('config', 'user.name', 'evidence');
    await writeFile(join(repo, 'old.mjs'), 'export const value = 1;\n');
    await writeFile(join(repo, 'source.mjs'), 'export const value = 1;\n');
    run('add', '.');
    run('commit', '-q', '-m', 'initial');
    run('mv', 'old.mjs', 'new name.mjs');
    await writeFile(join(repo, '변경 file.mjs'), 'export const value = 2;\n');
    const record = await collectEvidence({
      root: repo,
      caseId: 'renamed-path', language: 'js-ts',
      implementationFiles: ['source.mjs'], testFiles: ['source.mjs'], dependencyFiles: ['source.mjs'],
      buildFlags: ['node>=20'],
      result: { status: 'pass', expected: { status: 'pass', tests: 1 }, actual: { status: 'pass', tests: 1 }, elapsedMs: 1 },
    });
    assert.equal(validateEvidence(record).length, 0);
    const renamed = record.git.files.find(({ path }) => path === 'new name.mjs');
    assert.equal(renamed?.state, 'R ');
    assert.equal(renamed?.from, 'old.mjs');
    assert.match(renamed?.sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.ok(record.git.files.some(({ path, state }) => path === '변경 file.mjs' && state === '??'));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// A file of a dirty worktree can be larger than the memory of the process that records the evidence: untracked logs of window
// checks in a checkout reach tens of megabytes each. The digest reads a file in chunks, so the peak resident memory of the
// process does not grow with the size of the file.
test('evidence of a 256 MiB untracked file is collected with memory independent of the file size', { timeout: 60000 }, async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'soksak-evidence-memory-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  run('init', '-q');
  run('config', 'user.email', 'evidence@example.invalid');
  run('config', 'user.name', 'evidence');
  await writeFile(join(repo, 'source.mjs'), 'export const value = 1;\n');
  run('add', '.');
  run('commit', '-q', '-m', 'initial');
  // A process of its own collects the evidence of an untracked file of the given size and writes its resident memory before the
  // collection, its peak resident memory after it and the digest of the file on its last output line.
  const collect = async (size) => {
    const large = await open(join(repo, 'large.log'), 'w');
    await large.truncate(size);
    await large.close();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { collectEvidence } = await import(${JSON.stringify(new URL('../test-evidence.mjs', import.meta.url).href)});
      const before = process.memoryUsage.rss();
      const record = await collectEvidence({
        root: ${JSON.stringify(repo)}, caseId: 'large-untracked-file', language: 'js-ts',
        implementationFiles: ['source.mjs'], testFiles: ['source.mjs'], dependencyFiles: ['source.mjs'], buildFlags: [],
        result: { status: 'pass', expected: 1, actual: 1, elapsedMs: 1 },
      });
      const file = record.git.files.find(({ path }) => path === 'large.log');
      process.stdout.write(JSON.stringify({ before, peak: process.resourceUsage().maxRSS * 1024, sha256: file?.sha256 }) + '\\n');
    `], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout.trim().split('\n').at(-1));
    return { growth: report.peak - report.before, sha256: report.sha256 };
  };
  const small = await collect(1024 * 1024);
  const large = await collect(256 * 1024 * 1024);
  t.diagnostic(`peak resident memory growth: ${small.growth} bytes for 1 MiB, ${large.growth} bytes for 256 MiB`);
  // SHA-256 of 256 MiB of zero bytes.
  assert.equal(large.sha256, 'a6d72ac7690f53be6ae46ba88506bd97302a093f7108472bd9efc3cefda06484');
  // A whole-file read adds the 255 MiB of the size difference to the peak; a read in chunks of 64 KiB adds none of it, and 32 MiB
  // covers the variation of the heap between two processes.
  assert.ok(large.growth - small.growth < 32 * 1024 * 1024,
    `peak resident memory grew by ${large.growth} bytes for 256 MiB and by ${small.growth} bytes for 1 MiB`);
});

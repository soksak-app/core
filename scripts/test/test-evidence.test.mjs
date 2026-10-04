import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendEvidenceAttempt, collectEvidence, evidenceDrift, persistEvidence, validateEvidence } from '../test-evidence.mjs';

test('evidence records content hashes, dirty state, expected/actual result, and retry history', async (t) => {
  // 테스트 파일 집합은 명시적으로 유지하면서 git metadata에는 실제 저장소를 사용한다.
  const repo = process.cwd();
  const record = await collectEvidence({
    root: repo,
    caseId: 'evidence-self-test', language: 'js-ts',
    implementationFiles: ['scripts/test-evidence.mjs'],
    testFiles: ['scripts/test/test-evidence.test.mjs'],
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
      implementationFiles: ['scripts/test-evidence.mjs'],
      testFiles: ['scripts/test/test-evidence.test.mjs'],
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
  const { execFileSync } = await import('node:child_process');
  const { randomBytes } = await import('node:crypto');
  const { writeFile, rm } = await import('node:fs/promises');
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
  const { execFileSync } = await import('node:child_process');
  const { writeFile, rm } = await import('node:fs/promises');
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

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { collectEvidence, evidenceDrift, validateEvidence } from '../../../test-evidence.mjs';
import { hashFile } from '../../../candidate-identity.mjs';
import { processExecutable } from '../../../platform/darwin/process-executable.mjs';

const UNRELATED = fileURLToPath(new URL('../../fixtures/process-evidence/unrelated.txt', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'soksak-process-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyFile(UNRELATED, join(root, 'source.mjs'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return { root, caseId: 'process-identity', language: 'js-ts', implementationFiles: ['source.mjs'], testFiles: ['source.mjs'],
    dependencyFiles: ['source.mjs'], buildFlags: [], result: { status: 'pass', expected: 1, actual: 1, elapsedMs: 1 } };
}

test('process evidence rejects a live PID paired with an unrelated file', { timeout: 10000 }, async (t) => {
  const options = await fixture(t);
  await assert.rejects(() => collectEvidence({ ...options,
    processes: [{ pid: process.pid, executable: 'source.mjs' }] }), /executable mismatch/);
});

test('process evidence binds a matching kernel process to its executable hash', { timeout: 10000 }, async (t) => {
  const options = await fixture(t);
  const record = await collectEvidence({ ...options, processes: [{ pid: process.pid, executable: process.execPath }] });
  assert.deepEqual(record.processes, [{ pid: process.pid, executable: await realpath(process.execPath), sha256: await hashFile(process.execPath) }]);
  assert.deepEqual(validateEvidence(record), []);
  assert.deepEqual(evidenceDrift(record, { ...record, processes: [{ ...record.processes[0], sha256: '0'.repeat(64) }] }),
    ['evidence snapshot is stale: source, test, dependency, build, process, or dirty-worktree content changed']);
});

test('process identity preserves whitespace belonging to the executable path', { timeout: 10000 }, async () => {
  assert.equal(await processExecutable(process.pid, { execute: async () => ({ stdout: '/candidate/program \n' }) }), '/candidate/program ');
});

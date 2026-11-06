import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFile, hashTree } from '../candidate-identity.mjs';

test('candidate tree identity binds every file, executable mode and symlink target without extraction timestamps', { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'soksak-candidate-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'Contents'));
  const file = join(root, 'Contents', 'program');
  await writeFile(file, 'candidate');
  await symlink('program', join(root, 'Contents', 'link'));
  const first = await hashTree(root);
  await utimes(file, new Date(0), new Date(0));
  assert.equal(await hashTree(root), first);
  await chmod(file, 0o755);
  const executable = await hashTree(root);
  assert.notEqual(executable, first);
  await writeFile(file, 'changed candidate');
  const changed = await hashTree(root);
  assert.notEqual(changed, executable);
  await rm(join(root, 'Contents', 'link'));
  await symlink('other', join(root, 'Contents', 'link'));
  assert.notEqual(await hashTree(root), changed);
  const copied = join(root, 'copy');
  await copyFile(file, copied);
  assert.equal(await hashFile(file), await hashFile(copied));
  await assert.rejects(() => hashTree(copied), /directory/);
});

test('candidate tree identity refuses symlinks that escape the bundle', { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'soksak-candidate-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink('../outside', join(root, 'outside'));
  await assert.rejects(() => hashTree(root), /outside/);
});

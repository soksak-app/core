import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashTree } from '../candidate-identity.mjs';
import { candidateAssetNames, candidateFiles } from '../candidate-acceptance.mjs';

const BUNDLES = fileURLToPath(new URL('./fixtures/candidate-bundles/', import.meta.url));

async function rootFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'soksak-acceptance-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, name] of [['packages/plugin-api', '@soksak/plugin-api'], ['native/darwin/process-identity', '@soksak/native-process-identity-darwin'],
    ['packages/client', '@soksak/client'], ['packages/log-contract', '@soksak/log-contract'], ['packages/window-check', '@soksak/window-check']]) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, 'package.json'), JSON.stringify({ name, version: '0.0.39' }));
  }
  return root;
}

// The release files of a run: the zip of each candidate host bundle and the release file of each package, with the tree hash of each bundle.
async function releaseFiles(t) {
  const root = await rootFixture(t);
  const files = join(root, 'files');
  await mkdir(files);
  const { names } = await candidateAssetNames(root);
  const expected = new Map();
  for (const host of ['mygo', 'tauriv2', 'wailsv3']) {
    const folder = join(root, host);
    const bundle = join(folder, 'soksak.app');
    await cp(join(BUNDLES, host, 'Contents'), join(bundle, 'Contents'), { recursive: true });
    await chmod(join(bundle, 'Contents/MacOS', `sok-${host}`), 0o755);
    expected.set(host, await hashTree(bundle));
    execFileSync('zip', ['-q', '-r', join(files, `soksak-0.0.39-darwin-arm64-${host}.zip`), 'soksak.app'], { cwd: folder });
  }
  for (const name of names.filter((name) => name.endsWith('.tgz'))) await writeFile(join(files, name), 'packed release bytes');
  assert.deepEqual(names.filter((name) => name.endsWith('.tgz')), ['soksak-client-0.0.39.tgz', 'soksak-log-contract-0.0.39.tgz',
    'soksak-native-process-identity-darwin-0.0.39.tgz', 'soksak-plugin-api-0.0.39.tgz', 'soksak-window-check-0.0.39.tgz']);
  return { root, files, expected };
}

test('candidate publication hashes the exact downloaded files and complete bundle contents', { timeout: 10000 }, async (t) => {
  const { root, files, expected } = await releaseFiles(t);
  const observed = await candidateFiles(root, files);
  assert.equal(observed.assets.length, 8);
  assert.deepEqual(observed.bundles.map((b) => [b.app, b.bundleSha256]), [...expected]);
});

test('candidate publication refuses a release file set with an extra or a missing file', { timeout: 10000 }, async (t) => {
  const { root, files } = await releaseFiles(t);
  await writeFile(join(files, 'unaccepted.txt'), 'extra');
  await assert.rejects(() => candidateFiles(root, files), /must be exactly/);
  await rm(join(files, 'unaccepted.txt'));
  await rm(join(files, 'soksak-plugin-api-0.0.39.tgz'));
  await assert.rejects(() => candidateFiles(root, files), /must be exactly/);
});

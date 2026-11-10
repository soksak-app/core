import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFile, hashTree } from '../candidate-identity.mjs';
import { createCandidateContext } from '../candidate-context.mjs';

const repository = 'example/core';
const PACKAGES = [['packages/plugin-api', '@soksak/plugin-api'], ['native/darwin/process-identity', '@soksak/native-process-identity-darwin'],
  ['packages/client', '@soksak/client'], ['packages/log-contract', '@soksak/log-contract'], ['packages/window-check', '@soksak/window-check']];
const TGZ = ['soksak-client-0.0.39.tgz', 'soksak-log-contract-0.0.39.tgz', 'soksak-native-process-identity-darwin-0.0.39.tgz',
  'soksak-plugin-api-0.0.39.tgz', 'soksak-window-check-0.0.39.tgz'];
const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();

/** A committed candidate checkout, the zip of each GitHub artifact of its release run and the GitHub replies of that run. */
async function candidateFixture(t, { duplicate = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'soksak-candidate-context-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'checkout');
  for (const [path, name] of PACKAGES) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, 'package.json'), JSON.stringify({ name, version: '0.0.39' }));
  }
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(join(root, '.github/workflows/ci.yml'), 'jobs:\n  required:\n    name: required\n');
  git(base, 'init', '-q', root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'candidate');
  const sha = git(root, 'rev-parse', 'HEAD');
  const built = join(base, 'built');
  const bundles = new Map();
  for (const host of ['mygo', 'tauriv2', 'wailsv3']) {
    const folder = join(built, host);
    const bundle = join(folder, 'soksak.app');
    await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true });
    await writeFile(join(bundle, 'Contents/Info.plist'), `metadata ${host}`);
    await writeFile(join(bundle, 'Contents/MacOS', `sok-${host}`), `executable ${host}`);
    await chmod(join(bundle, 'Contents/MacOS', `sok-${host}`), 0o755);
    bundles.set(host, await hashTree(bundle));
    execFileSync('zip', ['-q', '-r', join(built, `soksak-0.0.39-darwin-arm64-${host}.zip`), 'soksak.app'], { cwd: folder });
  }
  for (const name of TGZ) await writeFile(join(built, name), `packed ${name}`);
  const members = { 'release-wailsv3': ['soksak-0.0.39-darwin-arm64-wailsv3.zip', ...TGZ], 'release-tauriv2': ['soksak-0.0.39-darwin-arm64-tauriv2.zip'],
    'release-mygo': ['soksak-0.0.39-darwin-arm64-mygo.zip', ...(duplicate ? [TGZ[0]] : [])] };
  const ids = { 'release-wailsv3': 30, 'release-tauriv2': 31, 'release-mygo': 32 };
  const zips = new Map();
  for (const [name, files] of Object.entries(members)) {
    const zip = join(base, `${name}.zip`);
    execFileSync('zip', ['-q', '-j', zip, ...files.map((file) => join(built, file))]);
    zips.set(ids[name], await readFile(zip));
  }
  const run = { id: 12, run_attempt: 2, head_sha: sha, status: 'completed', conclusion: 'success', event: 'push', head_branch: 'main',
    path: '.github/workflows/release.yml', repository: { full_name: repository }, head_repository: { full_name: repository },
    run_started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:10:00Z' };
  const jobs = ['checks / required', 'gate', 'release-wailsv3', 'release-tauriv2', 'release-mygo'].map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  const artifacts = Object.entries(ids).map(([name, id]) => ({ id, name, expired: false, created_at: '2026-01-01T00:05:00Z', workflow_run: { id: 12, head_sha: sha } }));
  const requested = [];
  const request = async (url, { headers }) => {
    requested.push(url);
    assert.equal(headers.Authorization, 'Bearer token');
    const path = url.replace(`https://api.github.com/repos/${repository}/`, '').replace(/\?.*$/, '');
    const reply = (body) => ({ ok: true, status: 200, json: async () => body });
    if (path === 'actions/runs/12/attempts/2') return reply(run);
    if (path === 'actions/runs/12/attempts/2/jobs') return reply({ jobs });
    if (path === 'actions/runs/12/artifacts') return reply({ artifacts });
    const download = /^actions\/artifacts\/(\d+)\/zip$/.exec(path);
    if (download) return { ok: true, status: 200, arrayBuffer: async () => zips.get(Number(download[1])) };
    return { ok: false, status: 404 };
  };
  return { base, root, sha, run, bundles, request, requested, out: join(base, 'context') };
}

test('a candidate context names the validated run, every release file and each bundle extracted as publication extracts it', { timeout: 10000 }, async (t) => {
  const { root, sha, bundles, request, out } = await candidateFixture(t);
  const context = await createCandidateContext({ root, repository, runId: 12, runAttempt: 2, out, token: 'token', request });
  assert.deepEqual(JSON.parse(await readFile(join(out, 'context.json'), 'utf8')), context);
  assert.deepEqual(context.candidate, { repository, workflow: '.github/workflows/release.yml', runId: 12, runAttempt: 2, sha, version: '0.0.39',
    artifacts: [{ id: 32, name: 'release-mygo' }, { id: 31, name: 'release-tauriv2' }, { id: 30, name: 'release-wailsv3' }] });
  assert.deepEqual(context.assets.map(({ name }) => name), ['soksak-0.0.39-darwin-arm64-mygo.zip', 'soksak-0.0.39-darwin-arm64-tauriv2.zip',
    'soksak-0.0.39-darwin-arm64-wailsv3.zip', ...TGZ].sort());
  for (const asset of context.assets) {
    assert.equal(asset.path, join(out, 'files', asset.name));
    assert.equal(await hashFile(asset.path), asset.sha256);
  }
  assert.deepEqual(context.hosts.map(({ app }) => app), ['mygo', 'tauriv2', 'wailsv3']);
  for (const { app, bundle } of context.hosts) {
    assert.equal(bundle, join(out, 'hosts', app, 'soksak.app'));
    assert.equal(await hashTree(bundle), bundles.get(app));
  }
  assert.equal(existsSync(join(out, 'downloads')), false, 'the downloaded artifact files are removed after extraction');
});

test('a candidate context refuses an attempt that publication would refuse before it downloads anything', { timeout: 10000 }, async (t) => {
  const { root, run, request, requested, out } = await candidateFixture(t);
  run.conclusion = 'failure';
  await assert.rejects(() => createCandidateContext({ root, repository, runId: 12, runAttempt: 2, out, token: 'token', request }), /successful main push/);
  assert.equal(existsSync(out), false);
  assert.equal(requested.some((url) => url.endsWith('/zip')), false);
});

test('a candidate context refuses a dirty checkout', { timeout: 10000 }, async (t) => {
  const { root, request, out } = await candidateFixture(t);
  await writeFile(join(root, 'untracked.txt'), 'local change');
  await assert.rejects(() => createCandidateContext({ root, repository, runId: 12, runAttempt: 2, out, token: 'token', request }), /dirty/);
  assert.equal(existsSync(out), false);
});

test('a candidate context never writes into an existing directory', { timeout: 10000 }, async (t) => {
  const { root, request, out } = await candidateFixture(t);
  await mkdir(out);
  await writeFile(join(out, 'kept.txt'), 'existing data');
  await assert.rejects(() => createCandidateContext({ root, repository, runId: 12, runAttempt: 2, out, token: 'token', request }), /EEXIST/);
  assert.equal(await readFile(join(out, 'kept.txt'), 'utf8'), 'existing data');
});

test('a candidate context refuses a release file that two artifacts hold', { timeout: 10000 }, async (t) => {
  const { root, request, out } = await candidateFixture(t, { duplicate: true });
  await assert.rejects(() => createCandidateContext({ root, repository, runId: 12, runAttempt: 2, out, token: 'token', request }), /more than one artifact/);
});

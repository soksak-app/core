import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hashFile, hashTree, hashValue } from '../candidate-identity.mjs';
import { decodeAcceptanceReport } from '../candidate-report.mjs';
import { collectAcceptanceInputs, finishAcceptanceRun, prepareCandidate, prepareOrdinaryArtifacts, sourceIdentity, writeAcceptanceReport } from '../acceptance-run.mjs';

const hosts = ['mygo', 'tauriv2', 'wailsv3'];
const platform = 'darwin-arm64';
async function put(file, value) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}

async function installed(config, { text = 'plugin bytes', enabled = true, version = '0.0.1', extra = false, worker } = {}) {
  const plugins = { fixture: { path: 'plugins/fixture/0.0.1', version, enabled, sidecars: worker ? { '@fixture/worker': '^0.0.1' } : {} } };
  if (extra) plugins.extra = { ...plugins.fixture, path: 'plugins/extra/0.0.1' };
  const sidecars = worker ? { '@fixture/worker': { version: worker.version ?? '0.0.1', path: `sidecars/fixture-worker/0.0.1/${platform}` } } : {};
  await put(join(config, 'plugins/installed.json'), { format: 3, plugins, sidecars });
  await put(join(config, plugins.fixture.path, 'package.json'), { name: '@fixture/plugin', version });
  await put(join(config, plugins.fixture.path, 'plugin.json'), { id: 'fixture', ...(worker ? { dependencies: { '@fixture/worker': '^0.0.1' } } : {}) });
  await put(join(config, plugins.fixture.path, 'index.js'), text);
  if (worker) {
    const path = join(config, sidecars['@fixture/worker'].path);
    await put(join(path, 'package.json'), { name: '@fixture/worker', version: worker.version ?? '0.0.1' });
    await put(join(path, 'sidecar.json'), { protocol: 1, executable: 'sok-fixture', displayName: 'soksak://sidecar/fixture' });
    await put(join(path, 'sok-fixture'), worker.text ?? 'sidecar executable bytes');
    await chmod(join(path, 'sok-fixture'), 0o755);
  }
}

async function fixture(t, { worker } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'soksak-candidate-owner-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const root = join(folder, 'source');
  await put(join(root, '.gitignore'), 'node_modules/\n');
  await put(join(root, 'package.json'), { private: true });
  await put(join(root, 'source.mjs'), 'export const value = 1;');
  await put(join(root, 'e2e/package.json'), { scripts: { 'test-app': 'node --test one.test.mjs',
    'test-app:activation': 'node --test activation.test.mjs', 'benchmark:fixture': 'node --test benchmark.test.mjs' } });
  await put(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'fixture'], { cwd: root });
  await put(join(root, 'node_modules/fixture/index.js'), 'installed dependency bytes');
  const context = {
    platform,
    schema: 1, candidate: { repository: 'fixture/core', workflow: 'release.yml', runId: 1, runAttempt: 1,
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), version: '0.0.1', artifacts: [{ id: 1, name: 'candidate' }] },
    assets: [], registry: { path: join(folder, 'registry.json'), pack: 'required', components: [
      { kind: 'plugin', id: 'fixture', version: '0.0.1', releaseSha256: '1'.repeat(64) },
    ] },
    hosts: hosts.map((app) => ({ app, bundle: join(folder, `${app}.app`) })),
  };
  await put(context.registry.path, { format: 1, plugins: [{ id: 'fixture', versions: [{ version: '0.0.1',
    release: { url: 'https://example.invalid/fixture.tgz', sha256: '1'.repeat(64) } }] }], sidecars: [],
    packs: [{ name: 'required', plugins: ['fixture'] }], revoked: { plugins: [], sidecars: [] } });
  if (worker) {
    const index = JSON.parse(await readFile(context.registry.path, 'utf8'));
    index.plugins[0].versions[0].sidecars = { '@fixture/worker': '^0.0.1' };
    context.registry.components.push({ kind: 'sidecar', id: '@fixture/worker', version: '0.0.1', releaseSha256: '2'.repeat(64) });
    index.sidecars.push({ name: '@fixture/worker', versions: [{ version: '0.0.1', protocol: 1,
      releases: { [platform]: { url: 'https://example.invalid/worker.tgz', sha256: '2'.repeat(64) } } }] });
    await put(context.registry.path, index);
  }
  context.registry.sha256 = await hashFile(context.registry.path);
  for (const host of context.hosts) {
    await put(join(host.bundle, 'Contents/MacOS', `sok-${host.app}`), `${host.app} executable`);
    await put(join(host.bundle, 'Contents/MacOS/sok'), 'candidate installer');
    const path = join(folder, `${host.app}.zip`);
    await put(path, `${host.app} release`);
    context.assets.push({ name: `${host.app}.zip`, path, sha256: await hashFile(path) });
  }
  const calls = [];
  const install = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'plugin') await installed(args.at(-1), { worker });
  };
  const configRoot = join(folder, 'configs');
  for (const [index, host] of context.hosts.entries()) {
    const config = join(configRoot, `soksak-check-${host.app}`);
    await installed(config, { worker });
    await put(join(config, 'endpoint.json'), { application: host.app, pid: index + 100,
      executable: join(host.bundle, 'Contents/MacOS', `sok-${host.app}`) });
  }
  const identify = async (_root, entry) => ({ ...entry, sha256: await hashFile(entry.executable) });
  return { folder, root, context, configRoot, install, calls, identify };
}

test('ordinary reference verifies every explicit plugin beyond the starter pack while candidate stays pack-only', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const index = JSON.parse(await readFile(f.context.registry.path, 'utf8'));
  index.plugins.push({ id: 'extra', versions: [{ version: '0.0.1', release: { url: 'https://example.invalid/extra.tgz', sha256: '3'.repeat(64) } }] });
  await put(f.context.registry.path, index);
  f.context.registry.sha256 = await hashFile(f.context.registry.path);
  f.context.registry.components.push({ kind: 'plugin', id: 'extra', version: '0.0.1', releaseSha256: '3'.repeat(64) });
  const calls = [], byConfig = new Map();
  const install = async (_command, args) => {
    if (args[0] !== 'plugin') return;
    const config = args.at(-1);
    const ids = byConfig.get(config) ?? new Set();
    ids.add(args[2]); byConfig.set(config, ids); calls.push(args[2]);
    await installed(config, { extra: ids.has('extra') });
    if (ids.has('extra')) {
      await put(join(config, 'plugins/extra/0.0.1/package.json'), { name: '@fixture/extra', version: '0.0.1' });
      await put(join(config, 'plugins/extra/0.0.1/plugin.json'), { id: 'extra' });
      await put(join(config, 'plugins/extra/0.0.1/index.js'), 'extra plugin bytes');
    }
  };
  const ordinary = structuredClone(f.context);
  delete ordinary.candidate;
  const prepared = await prepareOrdinaryArtifacts(ordinary, { install });
  t.after(() => prepared.dispose());
  assert.deepEqual(calls, ['fixture', 'extra'], 'ordinary reference must execute the real installer for all explicit plugins');
  assert.deepEqual(prepared.context.registry.components.map(({ id }) => id).sort(), ['extra', 'fixture']);
  for (const entry of prepared.context.registry.components) assert.match(entry.treeSha256, /^[0-9a-f]{64}$/);
  calls.length = 0;
  await assert.rejects(prepareCandidate(f.context, { install }), /installed component cohort differs/);
  assert.deepEqual(calls, ['fixture'], 'candidate keeps its original declared-pack-only policy');
});

test('candidate reference installation binds the frozen registry payload to the exact enabled installed cohort', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const prepared = await prepareCandidate(f.context, { install: f.install });
  t.after(() => prepared.dispose());
  assert.notEqual(prepared.context.registry.path, f.context.registry.path);
  assert.equal(await hashFile(prepared.context.registry.path), f.context.registry.sha256);
  assert.deepEqual(f.calls.map(([, args]) => args.slice(0, 3)), [['registry', 'use', prepared.context.registry.path], ['plugin', 'install', 'fixture']]);
  assert.ok(f.calls.every(([command]) => command === join(f.context.hosts[0].bundle, 'Contents/MacOS/sok')));
  const snapshot = await collectAcceptanceInputs(f.root, prepared.context, f.configRoot, { identify: f.identify });
  assert.equal(snapshot.dirty, false);
  assert.deepEqual(snapshot.hosts.map(({ app, pid }) => [app, pid]), [['mygo', 100], ['tauriv2', 101], ['wailsv3', 102]]);
  assert.equal(snapshot.hosts[0].componentsSha256, hashValue(prepared.context.registry.components));
  for (const changed of [{ text: 'changed payload' }, { enabled: false }, { version: '0.0.2' }, { extra: true }]) {
    await installed(join(f.configRoot, 'soksak-check-tauriv2'), changed);
    await assert.rejects(collectAcceptanceInputs(f.root, prepared.context, f.configRoot, { identify: f.identify }), /component|cohort|enabled|version/);
  }
});

test('candidate sidecar evidence binds the scoped dependency platform release and installed executable bytes', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { worker: {} });
  const prepared = await prepareCandidate(f.context, { install: f.install });
  t.after(() => prepared.dispose());
  const before = await collectAcceptanceInputs(f.root, prepared.context, f.configRoot, { identify: f.identify });
  assert.equal(prepared.context.registry.components[1].id, '@fixture/worker');
  assert.equal(before.hosts[0].componentsSha256, hashValue(prepared.context.registry.components));
  const altered = structuredClone(f.context);
  altered.registry.components[1].releaseSha256 = '3'.repeat(64);
  await assert.rejects(prepareCandidate(altered, { install: f.install }), /release checksum/);
  for (const worker of [{ version: '0.0.2' }, { text: 'another executable' }]) {
    await installed(join(f.configRoot, 'soksak-check-tauriv2'), { worker });
    await assert.rejects(collectAcceptanceInputs(f.root, prepared.context, f.configRoot, { identify: f.identify }), /version|verified release payload/);
  }
});

test('candidate source identity detects source, helper and dependency edits independently of HEAD', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const before = await sourceIdentity(f.root);
  await put(join(f.root, 'source.mjs'), 'export const value = 2;');
  const after = await sourceIdentity(f.root);
  assert.equal(after.head, before.head);
  assert.equal(after.dirty, true);
  assert.notEqual(after.sourceSha256, before.sourceSha256);
  await put(join(f.root, 'pnpm-lock.yaml'), 'lockfileVersion: 10');
  assert.notEqual((await sourceIdentity(f.root)).dependenciesSha256, before.dependenciesSha256);
  await put(join(f.root, 'e2e/package.json'), { scripts: {} });
  assert.notEqual((await sourceIdentity(f.root)).testsSha256, before.testsSha256);
});

test('candidate input identity follows installed dependency bytes and links beyond tracked lock declarations', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const prepared = await prepareCandidate(f.context, { install: f.install });
  t.after(() => prepared.dispose());
  await symlink('fixture', join(f.root, 'node_modules/fixture-link'));
  await symlink('.', join(f.root, 'node_modules/node_modules'));
  const before = await collectAcceptanceInputs(f.root, prepared.context, f.configRoot, { identify: f.identify });
  await put(join(f.root, 'node_modules/fixture/index.js'), 'changed installed dependency');
  const after = await collectAcceptanceInputs(f.root, prepared.context, f.configRoot, { identify: f.identify });
  assert.equal(after.dirty, false);
  assert.equal(after.dependenciesSha256, before.dependenciesSha256);
  assert.notEqual(after.installedDependenciesSha256, before.installedDependenciesSha256);
  await symlink(f.folder, join(f.root, 'node_modules/external'));
  await assert.rejects(collectAcceptanceInputs(f.root, prepared.context, f.configRoot, { identify: f.identify }), /dependency.*outside|outside.*dependency/);
});

test('candidate reference installation rejects altered index bytes and a different selected cohort', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const altered = structuredClone(f.context);
  altered.registry.sha256 = 'f'.repeat(64);
  await assert.rejects(prepareCandidate(altered, { install: f.install }), /registry bytes/);
  assert.equal(f.calls.length, 0, 'an unverified index must not reach an installer');
  await assert.rejects(prepareCandidate(f.context, { install: async (_command, args) => {
    if (args[0] === 'plugin') await installed(args.at(-1), { extra: true });
  } }), /cohort/);
});

test('candidate reference cleanup reports its failure together with the installer failure', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const installError = new Error('reference installation failed');
  const cleanupError = new Error('reference cleanup failed');
  let retained;
  t.after(async () => { if (retained) await rm(retained, { recursive: true, force: true }); });
  await assert.rejects(prepareCandidate(f.context, {
    install: async () => { throw installError; },
    remove: async (directory) => { retained = directory; throw cleanupError; },
  }), (error) => error instanceof AggregateError && sameErrors(error.errors, [installError, cleanupError]));
});

function sameErrors(actual, expected) {
  return actual.length === expected.length && actual.every((error, index) => error === expected[index]);
}

async function writeRun(f, prepared, { fileStatus = 'pass', auditStatus = 'pass', findings = [], judgmentRun = 'run', cleanup = 'pass', afterChange } = {}) {
  const runFolder = join(f.folder, 'run');
  await put(join(runFolder, 'manifest.json'), { schema: 1, run: 'run', started_us: 1, finished_us: 2,
    script: 'benchmark:fixture', selection: { only: null, exclude: [], changed: false, namePattern: null, apps: hosts },
    tests: [{ name: 'e2e/benchmark.test.mjs', status: fileStatus }] });
  await put(join(runFolder, 'judgment.json'), { schema: 1, run: judgmentRun,
    tests: hosts.map((app) => ({ app, name: `${app}: required`, result: 'pass' })), audit: { status: auditStatus, findings } });
  const before = await collectAcceptanceInputs(f.root, prepared.context, f.configRoot, { identify: f.identify });
  const after = structuredClone(before);
  after.hosts[0].pid += 1;
  afterChange?.(after);
  const afterCleanup = structuredClone(after);
  for (const host of afterCleanup.hosts) delete host.pid;
  const run = await finishAcceptanceRun({ runFolder, context: prepared.context, script: 'benchmark:fixture', initializationId: 'initial-1',
    before, after, afterCleanup, plan: { status: cleanup, steps: [{ name: 'remaining processes', status: cleanup }] } });
  return { runFolder, run };
}

test('candidate acceptance keeps real manifest results and rejects failed audits, stale identities and failed cleanup', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const prepared = await prepareCandidate(f.context, { install: f.install });
  t.after(() => prepared.dispose());
  const valid = await writeRun(f, prepared);
  assert.deepEqual(valid.run.errors, []);
  assert.equal(valid.run.tests[0].status, 'pass');
  assert.deepEqual(valid.run.audit, { status: 'pass', findings: [], apps: hosts });
  for (const invalid of [
    { fileStatus: 'skip' }, { fileStatus: 'fail' }, { auditStatus: 'fail', findings: ['between-test error'] },
    { judgmentRun: 'another-run' }, { cleanup: 'fail' },
    { afterChange: (value) => { value.hosts[0].bundleSha256 = 'f'.repeat(64); } },
  ]) {
    const { run } = await writeRun(f, prepared, invalid);
    assert.ok(run.errors.length > 0, JSON.stringify(invalid));
    if (invalid.fileStatus) assert.equal(run.tests[0].status, invalid.fileStatus, 'the actual result must not be replaced');
  }
});

test('candidate report exports only complete matching acceptance without local paths', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  f.context.candidate.localPath = f.folder;
  const prepared = await prepareCandidate(f.context, { install: f.install });
  t.after(() => prepared.dispose());
  const { runFolder } = await writeRun(f, prepared);
  const output = join(f.folder, 'report.json');
  await writeAcceptanceReport(f.context, [runFolder], output);
  const text = await readFile(output, 'utf8');
  assert.ok(!text.includes(f.folder));
  const report = decodeAcceptanceReport(text);
  assert.ok(!JSON.stringify(report).includes(f.folder), 'context-only local fields must not enter the decoded report');
  assert.equal(report.runs.length, 1);
  assert.deepEqual(report.runs[0].errors, []);
  assert.equal(report.registry.components[0].treeSha256, await hashTree(join(f.configRoot, 'soksak-check-tauriv2/plugins/fixture/0.0.1')));
  await writeRun(f, prepared, { cleanup: 'fail' });
  await assert.rejects(writeAcceptanceReport(f.context, [runFolder], output), /failed|incomplete/);
});

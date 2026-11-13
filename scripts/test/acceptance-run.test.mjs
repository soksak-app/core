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
// The fixture bundles have the layout of the macOS application, which the module reads on any system.
const system = 'darwin';
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
  // The fixtures of the checkout: one fixture plugin, and with worker one fixture sidecar.
  await put(join(root, 'e2e/fixtures/probe/plugin.json'), { id: 'fixture' });
  await put(join(root, 'e2e/fixtures/probe/package.json'), { name: '@fixture/plugin', version: '0.0.1' });
  if (worker) {
    await put(join(root, 'e2e/fixtures/sidecars/worker/sidecar.json'), { protocol: 1, executable: 'sok-fixture' });
    await put(join(root, 'e2e/fixtures/sidecars/worker/package.json'), { name: '@fixture/worker', version: '0.0.1' });
  }
  await put(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'fixture'], { cwd: root });
  await put(join(root, 'node_modules/fixture/index.js'), 'installed dependency bytes');
  const context = {
    schema: 1, candidate: { repository: 'fixture/core', workflow: 'release.yml', runId: 1, runAttempt: 1,
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), version: '0.0.1', artifacts: [{ id: 1, name: 'candidate' }] },
    assets: [],
    hosts: hosts.map((app) => ({ app, bundle: join(folder, `${app}.app`) })),
  };
  for (const host of context.hosts) {
    await put(join(host.bundle, 'Contents/MacOS', `sok-${host.app}`), `${host.app} executable`);
    await put(join(host.bundle, 'Contents/MacOS/sok'), 'candidate installer');
    const path = join(folder, `${host.app}.zip`);
    await put(path, `${host.app} release`);
    context.assets.push({ name: `${host.app}.zip`, path, sha256: await hashFile(path) });
  }
  const configRoot = join(folder, 'configs');
  for (const [index, host] of context.hosts.entries()) {
    const config = join(configRoot, `soksak-check-${host.app}`);
    await installed(config, { worker });
    await put(join(config, 'endpoint.json'), { application: host.app, pid: index + 100,
      executable: join(host.bundle, 'Contents/MacOS', `sok-${host.app}`) });
  }
  const identify = async (_root, entry) => ({ ...entry, sha256: await hashFile(entry.executable) });
  return { folder, root, context, configRoot, identify };
}

/** The installed component identity that a host snapshot of the configuration of app records. */
async function componentsOf(f, app, { worker } = {}) {
  const config = join(f.configRoot, `soksak-check-${app}`);
  const components = [{ kind: 'plugin', id: 'fixture', version: '0.0.1', treeSha256: await hashTree(join(config, 'plugins/fixture/0.0.1')) }];
  if (worker) components.push({ kind: 'sidecar', id: '@fixture/worker', version: '0.0.1', treeSha256: await hashTree(join(config, `sidecars/fixture-worker/0.0.1/${platform}`)) });
  return hashValue(components);
}

test('candidate and ordinary preparation validate the context without a registry, an installer or a reference configuration', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const prepared = await prepareCandidate(f.context);
  assert.deepEqual(prepared.context, f.context);
  await prepared.dispose();
  const ordinary = structuredClone(f.context);
  delete ordinary.candidate;
  assert.deepEqual((await prepareOrdinaryArtifacts(ordinary)).context, ordinary);
  await assert.rejects(prepareCandidate(ordinary), /schema must be 1/);
  const partial = structuredClone(f.context);
  partial.hosts.pop();
  await assert.rejects(prepareCandidate(partial), /every candidate host/);
  const changed = structuredClone(f.context);
  changed.assets[0].sha256 = 'f'.repeat(64);
  await assert.rejects(prepareCandidate(changed), /asset .* changed/);
});

test('collected inputs bind exactly the enabled installed fixtures of the checkout', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const { context } = await prepareCandidate(f.context);
  const snapshot = await collectAcceptanceInputs(f.root, context, f.configRoot, { platform: system, identify: f.identify });
  assert.equal(snapshot.dirty, false);
  assert.deepEqual(snapshot.hosts.map(({ app, pid }) => [app, pid]), [['mygo', 100], ['tauriv2', 101], ['wailsv3', 102]]);
  assert.equal(snapshot.hosts[0].componentsSha256, await componentsOf(f, 'mygo'));
  const tauri = join(f.configRoot, 'soksak-check-tauriv2');
  await installed(tauri, { text: 'changed payload' });
  const changed = await collectAcceptanceInputs(f.root, context, f.configRoot, { platform: system, identify: f.identify });
  assert.notEqual(changed.hosts[1].componentsSha256, snapshot.hosts[1].componentsSha256, 'a changed installed tree must change the identity');
  for (const [state, error] of [[{ enabled: false }, /enabled/], [{ extra: true }, /installed plugins differ from the fixture plugins/]]) {
    await installed(tauri, state);
    await assert.rejects(collectAcceptanceInputs(f.root, context, f.configRoot, { platform: system, identify: f.identify }), error);
  }
});

test('collected inputs bind the installed fixture sidecars of the checkout and their executable bytes', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { worker: {} });
  const { context } = await prepareCandidate(f.context);
  const before = await collectAcceptanceInputs(f.root, context, f.configRoot, { platform: system, identify: f.identify });
  assert.equal(before.hosts[0].componentsSha256, await componentsOf(f, 'mygo', { worker: true }));
  const tauri = join(f.configRoot, 'soksak-check-tauriv2');
  await installed(tauri, { worker: { text: 'another executable' } });
  const after = await collectAcceptanceInputs(f.root, context, f.configRoot, { platform: system, identify: f.identify });
  assert.notEqual(after.hosts[1].componentsSha256, before.hosts[1].componentsSha256);
  await installed(tauri);
  await assert.rejects(collectAcceptanceInputs(f.root, context, f.configRoot, { platform: system, identify: f.identify }), /installed sidecars differ/);
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
  const prepared = await prepareCandidate(f.context);
  await symlink('fixture', join(f.root, 'node_modules/fixture-link'));
  await symlink('.', join(f.root, 'node_modules/node_modules'));
  const before = await collectAcceptanceInputs(f.root, prepared.context, f.configRoot, { platform: system, identify: f.identify });
  await put(join(f.root, 'node_modules/fixture/index.js'), 'changed installed dependency');
  const after = await collectAcceptanceInputs(f.root, prepared.context, f.configRoot, { platform: system, identify: f.identify });
  assert.equal(after.dirty, false);
  assert.equal(after.dependenciesSha256, before.dependenciesSha256);
  assert.notEqual(after.installedDependenciesSha256, before.installedDependenciesSha256);
  await symlink(f.folder, join(f.root, 'node_modules/external'));
  await assert.rejects(collectAcceptanceInputs(f.root, prepared.context, f.configRoot, { platform: system, identify: f.identify }), /dependency.*outside|outside.*dependency/);
});

async function writeRun(f, prepared, { fileStatus = 'pass', auditStatus = 'pass', findings = [], judgmentRun = 'run', cleanup = 'pass', afterChange } = {}) {
  const runFolder = join(f.folder, 'run');
  await put(join(runFolder, 'manifest.json'), { schema: 1, run: 'run', started_us: 1, finished_us: 2,
    script: 'benchmark:fixture', selection: { only: null, exclude: [], changed: false, namePattern: null, apps: hosts },
    tests: [{ name: 'e2e/benchmark.test.mjs', status: fileStatus }] });
  await put(join(runFolder, 'judgment.json'), { schema: 1, run: judgmentRun,
    tests: hosts.map((app) => ({ app, name: `${app}: required`, result: 'pass' })), audit: { status: auditStatus, findings } });
  const before = await collectAcceptanceInputs(f.root, prepared.context, f.configRoot, { platform: system, identify: f.identify });
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
  const prepared = await prepareCandidate(f.context);
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
  const prepared = await prepareCandidate(f.context);
  const { runFolder } = await writeRun(f, prepared);
  const output = join(f.folder, 'report.json');
  await writeAcceptanceReport(f.context, [runFolder], output);
  const text = await readFile(output, 'utf8');
  assert.ok(!text.includes(f.folder));
  const report = decodeAcceptanceReport(text);
  assert.ok(!JSON.stringify(report).includes(f.folder), 'context-only local fields must not enter the decoded report');
  assert.equal(report.runs.length, 1);
  assert.deepEqual(report.runs[0].errors, []);
  assert.equal('registry' in report, false, 'a report names no registry');
  assert.equal(report.runs[0].before.hosts[1].componentsSha256, await componentsOf(f, 'tauriv2'));
  await writeRun(f, prepared, { cleanup: 'fail' });
  await assert.rejects(writeAcceptanceReport(f.context, [runFolder], output), /failed|incomplete/);
});

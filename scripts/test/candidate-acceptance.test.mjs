import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { hashValue } from '../candidate-identity.mjs';
import { hashFile, hashTree } from '../candidate-identity.mjs';
import { candidateAssetNames, candidateFiles, candidatePolicy, prepareCandidate, validateCandidateReport, validateCandidateRun } from '../candidate-acceptance.mjs';
import { candidateNativeTests, candidateScripts } from '../candidate-policy.mjs';
import { decodeAcceptanceReport, encodeAcceptanceReport } from '../candidate-report.mjs';
import { finishAcceptanceRun, writeAcceptanceReport } from '../acceptance-run.mjs';

const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
function fixture() {
  const candidate = { repository: 'example/core', workflow: '.github/workflows/release.yml', runId: 12, runAttempt: 2, sha, version: '0.0.39', artifacts: [{ id: 30, name: 'release-wailsv3' }, { id: 31, name: 'release-tauriv2' }, { id: 32, name: 'release-mygo' }] };
  const assets = ['wails.zip', 'tauri.zip', 'mygo.zip', 'api.tgz', 'native.tgz'].map((name) => ({ name, sha256: digest }));
  const components = [{ kind: 'plugin', id: 'layoutprobe', version: '0.0.1', treeSha256: digest }];
  const bundles = ['mygo', 'tauriv2', 'wailsv3'].map((app) => ({ app, bundleSha256: digest, executableSha256: digest }));
  const source = { head: sha, dirty: false, sourceSha256: digest, testsSha256: digest, dependenciesSha256: digest };
  const identity = { ...source, installedDependenciesSha256: digest, hosts: bundles.map((bundle) => ({ ...bundle, pid: 1, componentsSha256: hashValue(components) })) };
  const required = [{ script: 'test-app', tests: ['e2e/required.test.mjs'], native: ['native_test'], steps: ['window checks', 'native end-to-end tests', 'remaining processes'] }];
  const runs = ['one', 'two'].map((initializationId) => ({ id: initializationId, initializationId, script: 'test-app', errors: [], selection: { only: null, exclude: [], changed: false, namePattern: null, apps: ['mygo', 'tauriv2', 'wailsv3'] },
    before: structuredClone(identity), after: structuredClone(identity), afterCleanup: { ...source, installedDependenciesSha256: digest, hosts: identity.hosts.map(({ pid, ...host }) => host) },
    tests: [{ name: 'e2e/required.test.mjs', status: 'pass' }], audit: { status: 'pass', findings: [], apps: ['mygo', 'tauriv2', 'wailsv3'] },
    plan: { status: 'pass', steps: required[0].steps.map((name) => ({ name, status: 'pass' })) }, native: { tests: [{ name: 'native_test', status: 'pass' }] } }));
  return { report: { schema: 1, candidate, assets, runs }, expected: structuredClone({ candidate, assets, bundles, source, required }) };
}

test('candidate acceptance requires complete matching evidence from two independent initial states', { timeout: 10000 }, () => {
  const { report, expected } = fixture();
  assert.deepEqual(validateCandidateReport(report, expected), []);
  report.runs[1].before.hosts[0].pid = 2;
  report.runs[1].after.hosts[0].pid = 3;
  assert.deepEqual(validateCandidateReport(report, expected), [], 'a verified relaunch may change only the PID');
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 60000);
});

for (const [name, change, error] of [
  ['candidate acceptance refuses missing evidence', (r) => { r.runs[0].tests = []; }, /test files/],
  ['candidate acceptance refuses missing collection evidence', (r) => { delete r.runs[0].errors; }, /collection/],
  ['candidate acceptance refuses stale source evidence', (r) => { r.runs[0].before.head = 'c'.repeat(40); }, /source/],
  ['candidate acceptance refuses mismatched candidate evidence', (r) => { r.candidate.runAttempt++; }, /candidate/],
  ['candidate acceptance refuses mismatched bytes evidence', (r) => { r.assets[0].sha256 = 'c'.repeat(64); }, /release files/],
  ['candidate acceptance refuses changed bundle evidence', (r) => { r.runs[0].after.hosts[0].bundleSha256 = 'c'.repeat(64); }, /bundle/],
  ['candidate acceptance refuses changed installed fixture evidence', (r) => { r.runs[0].after.hosts[0].componentsSha256 = 'c'.repeat(64); }, /installed fixture identity/],
  ['candidate acceptance refuses installed fixtures that differ between runs', (r) => {
    for (const phase of ['before', 'after', 'afterCleanup']) for (const host of r.runs[1][phase].hosts) host.componentsSha256 = 'c'.repeat(64);
  }, /installed fixture identity/],
  ['candidate acceptance refuses a report that names a registry', (r) => { r.registry = { sha256: digest, pack: 'starter', components: [] }; }, /names no registry/],
  ['candidate acceptance refuses changed installed dependency evidence', (r) => { r.runs[0].after.installedDependenciesSha256 = 'c'.repeat(64); }, /dependencies/],
  ['candidate acceptance refuses skipped evidence', (r) => { r.runs[0].tests[0].status = 'skip'; }, /pass/],
  ['candidate acceptance refuses failed evidence', (r) => { r.runs[0].tests[0].status = 'fail'; }, /pass/],
  ['candidate acceptance refuses global log error evidence', (r) => { r.runs[0].audit.findings.push('outside a case'); }, /audit/],
  ['candidate acceptance refuses native omission evidence', (r) => { r.runs[0].native = null; }, /native/],
  ['candidate acceptance refuses cleanup failure evidence', (r) => { r.runs[0].plan.steps.at(-1).status = 'fail'; }, /plan/],
  ['candidate acceptance refuses partial selection evidence', (r) => { r.runs[0].selection.only = 'required'; }, /selection/],
  ['candidate acceptance refuses missing selection evidence', (r) => { delete r.runs[0].selection.changed; }, /selection/],
  ['candidate acceptance refuses evidence without every host', (r) => { r.runs[0].audit.apps.pop(); }, /every candidate host/],
  ['candidate acceptance refuses reused initialization evidence', (r) => { r.runs[1].initializationId = r.runs[0].initializationId; }, /independent/],
]) test(name, { timeout: 10000 }, () => {
  const { report, expected } = fixture();
  change(report);
  assert.match(validateCandidateReport(report, expected).join('\n'), error);
});

test('candidate publication validates the completed attempt and immutable artifact ownership', { timeout: 10000 }, () => {
  const { report } = fixture();
  const run = { id: 12, run_attempt: 2, head_sha: sha, status: 'completed', conclusion: 'success', event: 'push', head_branch: 'main', path: '.github/workflows/release.yml', repository: { full_name: 'example/core' }, head_repository: { full_name: 'example/core' }, run_started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:10:00Z' };
  const jobs = ['checks / required', 'gate', 'release-wailsv3', 'release-tauriv2', 'release-mygo'].map((name) => ({ name, conclusion: 'success', status: 'completed' }));
  const artifacts = report.candidate.artifacts.map((a) => ({ ...a, expired: false, created_at: '2026-01-01T00:05:00Z', workflow_run: { id: 12, head_sha: sha } }));
  const expected = { repository: 'example/core', sha, requiredJobs: jobs.map((j) => j.name), run, jobs, artifacts };
  assert.deepEqual(validateCandidateRun(report.candidate, expected), []);
  artifacts[0].created_at = '2025-01-01T00:00:00Z';
  assert.match(validateCandidateRun(report.candidate, expected).join('\n'), /attempt/);
  artifacts[0].created_at = '2026-01-01T00:05:00Z';
  jobs[0].conclusion = 'skipped';
  assert.match(validateCandidateRun(report.candidate, expected).join('\n'), /job/);
});

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

test('candidate publication hashes the exact downloaded files and complete bundle contents', { timeout: 10000 }, async (t) => {
  const root = await rootFixture(t);
  const files = join(root, 'files');
  await mkdir(files);
  const { names } = await candidateAssetNames(root);
  const expected = new Map();
  for (const host of ['mygo', 'tauriv2', 'wailsv3']) {
    const folder = join(root, host);
    const bundle = join(folder, 'soksak.app');
    await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true });
    await writeFile(join(bundle, 'Contents/Info.plist'), 'candidate metadata');
    await writeFile(join(bundle, 'Contents/MacOS', `sok-${host}`), `executable ${host}`);
    await chmod(join(bundle, 'Contents/MacOS', `sok-${host}`), 0o755);
    expected.set(host, await hashTree(bundle));
    execFileSync('zip', ['-q', '-r', join(files, `soksak-0.0.39-darwin-arm64-${host}.zip`), 'soksak.app'], { cwd: folder });
  }
  for (const name of names.filter((name) => name.endsWith('.tgz'))) await writeFile(join(files, name), 'packed release bytes');
  assert.deepEqual(names.filter((name) => name.endsWith('.tgz')), ['soksak-client-0.0.39.tgz', 'soksak-log-contract-0.0.39.tgz',
    'soksak-native-process-identity-darwin-0.0.39.tgz', 'soksak-plugin-api-0.0.39.tgz', 'soksak-window-check-0.0.39.tgz']);
  const observed = await candidateFiles(root, files);
  assert.equal(observed.assets.length, 8);
  assert.deepEqual(observed.bundles.map((b) => [b.app, b.bundleSha256]), [...expected]);
  await writeFile(join(files, 'unaccepted.txt'), 'extra');
  await assert.rejects(() => candidateFiles(root, files), /must be exactly/);
});

test('candidate preparation reads every page of the selected attempt and refuses a stale source', { timeout: 10000 }, async (t) => {
  const root = await rootFixture(t);
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(join(root, '.github/workflows/ci.yml'), 'jobs:\n  required:\n    runs-on: example\n');
  const { report } = fixture();
  const start = '2026-01-01T00:00:00Z';
  const end = '2026-01-01T00:10:00Z';
  const run = { id: 12, run_attempt: 2, head_sha: sha, status: 'completed', conclusion: 'success', event: 'push', head_branch: 'main', path: report.candidate.workflow, repository: { full_name: 'example/core' }, head_repository: { full_name: 'example/core' }, run_started_at: start, updated_at: end };
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    let value;
    if (url.includes('/jobs?')) value = { jobs: url.endsWith('page=1') ? Array.from({ length: 100 }, (_, index) => ({ name: `unrelated ${index}` })) :
      ['checks / required', 'gate', 'release-mygo', 'release-tauriv2', 'release-wailsv3'].map((name) => ({ name, status: 'completed', conclusion: 'success' })) };
    else if (url.includes('/artifacts?')) value = { artifacts: report.candidate.artifacts.map((a) => ({ ...a, expired: false, created_at: end, workflow_run: { id: 12, head_sha: sha } })) };
    else value = run;
    return { ok: true, json: async () => value };
  };
  const env = { GITHUB_REPOSITORY: 'example/core', GITHUB_SHA: sha, GITHUB_TOKEN: 'fixture-token' };
  assert.deepEqual(await prepareCandidate(report, { root, env, request }), report.candidate);
  assert.ok(calls.some((call) => call.endsWith('/attempts/2/jobs?per_page=100&page=2')));
  await assert.rejects(() => prepareCandidate(report, { root, env: { ...env, GITHUB_SHA: 'c'.repeat(40) }, request }), /stale|successful/);
});

test('candidate policy reuses declared application scripts and native mode arguments', { timeout: 10000 }, () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  assert.ok(candidateScripts(root).includes('benchmark:view-drag'));
  assert.ok(candidateNativeTests(root, 'test-app').includes('capture_resize_test'));
  assert.ok(candidateNativeTests(root, 'test-app:activation').includes('webview_input_test --monitor'));
  assert.ok(candidateNativeTests(root, 'test-app:activation').includes('input_virtual_ime_test'));
  assert.deepEqual(candidateNativeTests(root, 'benchmark:view-drag'), []);
});

test('the complete current candidate policy fits the authenticated report input', { timeout: 10000 }, async (t) => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const { report, expected } = fixture();
  const required = await candidatePolicy(root);
  const template = report.runs[0];
  report.runs = required.flatMap((policy, index) => [0, 1].map((initial) => ({ ...structuredClone(template),
    id: `candidate-00000000-0000-4000-8000-${String(index * 2 + initial).padStart(12, '0')}`,
    initializationId: `00000000-0000-4000-8000-${String(index * 2 + initial).padStart(12, '0')}`,
    script: policy.script,
    tests: policy.tests.map((name) => ({ name, status: 'pass' })),
    native: policy.native.length ? { tests: policy.native.map((name) => ({ name, status: 'pass' })) } : null,
    plan: { status: 'pass', steps: policy.steps.map((name) => ({ name, status: 'pass' })) },
  })));
  assert.deepEqual(validateCandidateReport(report, { ...expected, required }), []);
  const encoded = encodeAcceptanceReport(report);
  assert.deepEqual(decodeAcceptanceReport(encoded), report);
  assert.ok(Buffer.byteLength(encoded) <= 60000);
  t.diagnostic(`complete policy report: ${Buffer.byteLength(JSON.stringify(report))} decoded bytes, ${Buffer.byteLength(encoded)} transport bytes`);
});

test('candidate report transport rejects unsupported, corrupted and oversized input', { timeout: 10000 }, () => {
  assert.throws(() => decodeAcceptanceReport(JSON.stringify(fixture().report)), /transport/);
  assert.throws(() => decodeAcceptanceReport(JSON.stringify({ schema: 1, encoding: 'gzip-base64', payload: '****' })), /transport/);
  assert.throws(() => decodeAcceptanceReport(' '.repeat(60001)), /60000/);
  assert.throws(() => encodeAcceptanceReport({ value: 'x'.repeat(1024 * 1024) }), /1048576/);
  const expanded = JSON.stringify({ schema: 1, encoding: 'gzip-base64', payload: gzipSync('x'.repeat(1024 * 1024 + 1)).toString('base64') });
  assert.throws(() => decodeAcceptanceReport(expanded), /larger|length|size|Buffer/i);
});

test('collected manifests round trip through the publication gate without a second result model', { timeout: 10000 }, async (t) => {
  const root = await rootFixture(t);
  const { report, expected } = fixture();
  const context = { schema: 1, candidate: report.candidate, assets: [] };
  for (const asset of report.assets) {
    const path = join(root, asset.name);
    await writeFile(path, `candidate ${asset.name}`);
    asset.sha256 = await hashFile(path);
    context.assets.push({ ...asset, path });
  }
  expected.assets = structuredClone(report.assets);
  const folders = [];
  for (const run of report.runs) {
    const folder = join(root, run.id);
    folders.push(folder);
    await mkdir(join(folder, 'native'), { recursive: true });
    const selection = { only: null, exclude: [], changed: false, namePattern: null, apps: ['mygo', 'tauriv2', 'wailsv3'] };
    await writeFile(join(folder, 'manifest.json'), JSON.stringify({ schema: 1, run: run.id, script: run.script, finished_us: 2, selection, tests: run.tests }));
    await writeFile(join(folder, 'judgment.json'), JSON.stringify({ schema: 1, run: run.id, audit: { status: 'pass', findings: [] },
      tests: ['mygo', 'tauriv2', 'wailsv3'].map((app) => ({ name: 'required', app, result: 'pass' })) }));
    await writeFile(join(folder, 'native/manifest.json'), JSON.stringify({ schema: 1, run: 'native', finished_us: 2, tests: run.native.tests }));
    const result = await finishAcceptanceRun({ runFolder: folder, context, ...run });
    assert.deepEqual(result.errors, []);
  }
  const output = join(root, 'transport.json');
  await writeAcceptanceReport(context, folders, output);
  const transported = decodeAcceptanceReport(await readFile(output, 'utf8'));
  assert.deepEqual(validateCandidateReport(transported, expected), []);
});

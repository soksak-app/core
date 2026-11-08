import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { CANDIDATE_HOSTS, CANDIDATE_PLATFORM, candidateNativeTests, candidateScripts } from './candidate-policy.mjs';
import { applicationExecutables, releaseKey } from './platform/platform.js';
import { hashFile, hashTree, hashValue } from './candidate-identity.mjs';
import { decodeAcceptanceReport, MAX_REPORT_BYTES } from './candidate-report.mjs';

const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const sorted = (values) => [...values].sort();
const sameSet = (actual, expected) => Array.isArray(actual) && new Set(actual).size === actual.length
  && isDeepStrictEqual(sorted(actual), sorted(expected));
const text = (value) => typeof value === 'string' && value.length > 0;
const positive = (value) => Number.isSafeInteger(value) && value > 0;

/** A report is an authenticated maintainer submission; these checks bind its claims to the selected candidate and policy. */
export function validateCandidateReport(report, { candidate, assets, bundles, source, required }) {
  const errors = [];
  const need = (condition, message) => { if (!condition) errors.push(message); };
  need(report?.schema === 1, 'unsupported candidate acceptance schema');
  if (!report || typeof report !== 'object') return errors;
  need(Buffer.byteLength(JSON.stringify(report)) <= MAX_REPORT_BYTES, 'candidate acceptance report exceeds the decoded byte limit');
  need(isDeepStrictEqual(report.candidate, candidate), 'acceptance candidate differs from the selected candidate');
  need(source?.head === candidate?.sha, 'publication source does not identify the selected candidate');
  const orderedAssets = (list) => Array.isArray(list) ? [...list].sort((a, b) => String(a.name).localeCompare(String(b.name))) : null;
  need(isDeepStrictEqual(orderedAssets(report.assets), orderedAssets(assets)), 'acceptance release files do not match the exact published bytes');
  const registry = report.registry;
  need(digest(registry?.sha256) && text(registry?.pack), 'missing frozen registry identity or install pack');
  const components = registry?.components;
  need(Array.isArray(components) && components.length > 0, 'missing installed component identities');
  let componentsSha256;
  if (Array.isArray(components)) {
    const keys = components.map((c) => `${c.kind}:${c.id}`);
    need(new Set(keys).size === keys.length, 'duplicate installed component identity');
    need(isDeepStrictEqual(keys, sorted(keys)), 'component identities are not in canonical order');
    for (const component of components) need(['plugin', 'sidecar'].includes(component.kind) && text(component.id)
      && text(component.version) && digest(component.releaseSha256) && digest(component.treeSha256), 'incomplete component identity');
    componentsSha256 = hashValue(components);
  }
  need(Array.isArray(report.runs) && report.runs.length > 0, 'missing acceptance runs');
  if (!Array.isArray(report.runs)) return errors;
  need(new Set(report.runs.map((r) => r.id)).size === report.runs.length, 'duplicate acceptance run');
  const checkTests = (tests, names, label) => {
    need(sameSet(tests?.map((t) => t.name), names), `${label}: required test files or cases are missing, duplicated or unexpected`);
    need(Array.isArray(tests) && tests.every((t) => t.status === 'pass'), `${label}: every required result must pass`);
  };
  for (const run of report.runs) {
    const policy = required.find((entry) => entry.script === run.script);
    need(Boolean(policy), `unexpected candidate script ${run.script}`);
    if (!policy) continue;
    const label = `${run.script}/${run.id}`;
    need(Array.isArray(run.errors) && run.errors.length === 0, `${label}: candidate collection is incomplete or reported a failure`);
    need(text(run.id) && text(run.initializationId), `${label}: missing independent initialization identity`);
    const selection = run.selection;
    need(selection && selection.only === null && Array.isArray(selection.exclude) && selection.exclude.length === 0
      && selection.changed === false && selection.namePattern === null && sameSet(selection.apps, CANDIDATE_HOSTS), `${label}: partial or missing acceptance selection`);
    for (const phase of ['before', 'after', 'afterCleanup']) {
      const snapshot = run[phase];
      const snapshotSource = snapshot && Object.fromEntries(Object.keys(source).map((key) => [key, snapshot[key]]));
      need(isDeepStrictEqual(snapshotSource, source) && source.dirty === false, `${label}/${phase}: source identity is stale or dirty`);
      need(digest(snapshot?.installedDependenciesSha256) && snapshot.installedDependenciesSha256 === run.before?.installedDependenciesSha256,
        `${label}/${phase}: installed test dependencies changed or were not identified`);
      need(sameSet(snapshot?.hosts?.map((host) => host.app), CANDIDATE_HOSTS), `${label}/${phase}: every candidate host is required`);
      for (const host of snapshot?.hosts ?? []) {
        const expected = bundles.find((bundle) => bundle.app === host.app);
        need(expected && host.bundleSha256 === expected.bundleSha256 && host.executableSha256 === expected.executableSha256,
          `${label}/${phase}/${host.app}: candidate bundle or executable differs from the published release`);
        need(digest(host.componentsSha256) && host.componentsSha256 === componentsSha256, `${label}/${phase}/${host.app}: component identity differs from the verified cohort`);
        if (phase !== 'afterCleanup') need(positive(host.pid), `${label}/${phase}/${host.app}: missing verified live PID`);
      }
    }
    checkTests(run.tests, policy.tests, label);
    need(run.audit?.status === 'pass' && Array.isArray(run.audit?.findings) && run.audit.findings.length === 0, `${label}: full log audit did not pass`);
    need(sameSet(run.audit?.apps, CANDIDATE_HOSTS), `${label}: log audit did not observe every candidate host`);
    need(run.plan?.status === 'pass' && sameSet(run.plan?.steps?.map((s) => s.name), policy.steps)
      && run.plan.steps.every((s) => s.status === 'pass'), `${label}: complete preparation, check and cleanup plan must pass`);
    if (policy.native.length) checkTests(run.native?.tests, policy.native, `${label}/native`);
    else need(run.native === null, `${label}: unexpected native result`);
  }
  for (const policy of required) {
    const runs = report.runs.filter((run) => run.script === policy.script);
    need(runs.length === 2 && new Set(runs.map((run) => run.initializationId)).size === 2,
      `${policy.script}: exactly two independent initial states are required`);
  }
  return errors;
}

/** Candidate jobs and artifacts belong to one completed push attempt, never the latest run found by name. */
export function validateCandidateRun(candidate, { repository, sha, requiredJobs, run, jobs, artifacts }) {
  const errors = [];
  const need = (condition, message) => { if (!condition) errors.push(message); };
  need(candidate?.repository === repository && candidate?.sha === sha && /^[0-9a-f]{40}$/.test(candidate?.sha ?? ''), 'candidate repository or source is stale');
  need(positive(candidate?.runId) && positive(candidate?.runAttempt), 'candidate run and attempt must be positive integers');
  need(candidate?.workflow === '.github/workflows/release.yml', 'candidate workflow is not the release workflow');
  need(run?.id === candidate?.runId && run?.run_attempt === candidate?.runAttempt && run?.head_sha === sha
    && run?.repository?.full_name === repository && run?.head_repository?.full_name === repository
    && run?.event === 'push' && run?.head_branch === 'main' && run?.path === candidate?.workflow
    && run?.status === 'completed' && run?.conclusion === 'success', 'candidate is not a successful main push attempt of this repository');
  for (const name of requiredJobs) {
    const matches = (jobs ?? []).filter((job) => job.name === name);
    need(matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success', `required candidate job ${name} did not succeed`);
  }
  need(sameSet(candidate?.artifacts?.map((a) => a.name), CANDIDATE_HOSTS.map((host) => `release-${host}`)), 'candidate artifacts must be exactly the outputs of the candidate hosts');
  need(new Set(candidate?.artifacts?.map((a) => a.id)).size === CANDIDATE_HOSTS.length, 'candidate artifact identities must be distinct');
  for (const artifact of candidate?.artifacts ?? []) {
    const actual = (artifacts ?? []).find((entry) => entry.id === artifact.id);
    need(positive(artifact.id) && actual?.name === artifact.name && actual?.expired === false
      && actual?.workflow_run?.id === candidate.runId && actual?.workflow_run?.head_sha === sha,
    `candidate artifact ${artifact.id} is missing, expired or belongs to another candidate`);
    const created = Date.parse(actual?.created_at);
    need(Number.isFinite(created) && created >= Date.parse(run?.run_started_at) && created <= Date.parse(run?.updated_at),
      `candidate artifact ${artifact.id} does not belong to the selected attempt`);
  }
  return errors;
}

async function jsonFile(path) { return JSON.parse(await readFile(path, 'utf8')); }
function refuse(errors) { if (errors.length) throw new Error(errors.join('\n')); }

/** The exact published release filenames, one bundle of each candidate host and the packages, derived from the candidate's own package declarations. */
export async function candidateAssetNames(root) {
  const manifests = await Promise.all(['packages/plugin-api/package.json', 'native/darwin/process-identity/package.json'].map((path) => jsonFile(join(root, path))));
  const version = manifests[0].version;
  if (!/^\d+\.\d+\.\d+$/.test(version) || manifests.some((m) => m.version !== version)) throw new Error('candidate package versions differ');
  return { version, names: [...CANDIDATE_HOSTS.map((host) => `soksak-${version}-${releaseKey(host, CANDIDATE_PLATFORM)}.zip`),
    ...manifests.map((m) => `${m.name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`)].sort() };
}

/** Reuses canonical scripts and native runner arguments; the report cannot choose its required subset. */
export async function candidatePolicy(root, context) {
  const { discoverNodeTests } = await import('./node-tests.mjs');
  const { candidatePlanNames } = await import('./test-app.mjs');
  return Promise.all(candidateScripts(root).map(async (script) => {
    const native = candidateNativeTests(root, script);
    const tests = discoverNodeTests({ root, packages: ['e2e'], script }).tests.map((item) => item.name);
    if (!tests.length) throw new Error(`${script}: candidate policy declares no test files`);
    return { script, tests, native, steps: await candidatePlanNames(context, script) };
  }));
}

/** Hashes the downloaded files and their complete extracted bundles; no candidate is rebuilt for publication. */
export async function candidateFiles(root, directory) {
  const { version, names } = await candidateAssetNames(root);
  const actual = (await readdir(directory)).sort();
  if (!sameSet(actual, names)) throw new Error(`candidate release files must be exactly ${names.join(', ')}`);
  const assets = await Promise.all(names.map(async (name) => ({ name, sha256: await hashFile(join(directory, name)) })));
  const bundles = [];
  for (const app of CANDIDATE_HOSTS) {
    const path = join(directory, `soksak-${version}-${releaseKey(app, CANDIDATE_PLATFORM)}.zip`);
    const entries = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
    if (!entries.length || entries.some((entry) => entry.startsWith('/') || entry.includes('\\') || entry.split('/').includes('..')
      || (!entry.startsWith('soksak.app/') && !entry.startsWith('__MACOSX/')))) throw new Error(`${path}: unexpected release member path`);
    const temporary = await mkdtemp(join(tmpdir(), 'soksak-publish-bundle-'));
    try {
      execFileSync('unzip', ['-q', path, '-d', temporary], { stdio: 'pipe' });
      const bundle = join(temporary, 'soksak.app');
      bundles.push({ app, bundleSha256: await hashTree(bundle), executableSha256: await hashFile((await applicationExecutables(bundle, app, CANDIDATE_PLATFORM)).application) });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  return { assets, bundles };
}

async function github(path, env, request) {
  const response = await request(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`candidate metadata request failed: ${response.status} ${path}`);
  return response.json();
}

async function pages(path, key, env, request) {
  const entries = [];
  for (let page = 1; ; page++) {
    const data = await github(`${path}?per_page=100&page=${page}`, env, request);
    if (!Array.isArray(data[key])) throw new Error(`candidate metadata lacks ${key}`);
    entries.push(...data[key]);
    if (data[key].length < 100) return entries;
  }
}

/** Fetches attempt-specific job evidence and fixed artifact IDs under the workflow dispatch authority. */
export async function prepareCandidate(report, { root, env = process.env, request = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') || !env.GITHUB_TOKEN) throw new Error('candidate publication needs repository and token context');
  const candidate = report?.candidate;
  if (!positive(candidate?.runId) || !positive(candidate?.runAttempt)) throw new Error('candidate run and attempt are required');
  const { version } = await candidateAssetNames(root);
  if (candidate.version !== version) throw new Error('candidate version differs from the checked out source');
  const ci = parseYaml(await readFile(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const requiredJobs = ['gate', ...CANDIDATE_HOSTS.map((host) => `release-${host}`), ...Object.entries(ci.jobs).map(([key, value]) => `checks / ${value.name ?? key}`)];
  const run = await github(`actions/runs/${candidate.runId}/attempts/${candidate.runAttempt}`, env, request);
  const jobs = await pages(`actions/runs/${candidate.runId}/attempts/${candidate.runAttempt}/jobs`, 'jobs', env, request);
  const artifacts = await pages(`actions/runs/${candidate.runId}/artifacts`, 'artifacts', env, request);
  refuse(validateCandidateRun(candidate, { repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA, requiredJobs, run, jobs, artifacts }));
  return candidate;
}

async function main(argv) {
  const [command, reportPath, directory] = argv;
  if (!['prepare', 'verify'].includes(command) || !reportPath || (command === 'verify' && !directory)) throw new Error('usage: candidate-acceptance.mjs prepare REPORT | verify REPORT RELEASE_FILES');
  const text = await readFile(reportPath, 'utf8');
  const report = decodeAcceptanceReport(text);
  const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
  const candidate = await prepareCandidate(report, { root });
  if (command === 'prepare') {
    if (!process.env.GITHUB_OUTPUT) throw new Error('candidate preparation needs GITHUB_OUTPUT');
    await appendFile(process.env.GITHUB_OUTPUT, `artifact_ids=${candidate.artifacts.map((a) => a.id).join(',')}\nrun_id=${candidate.runId}\nversion=${candidate.version}\nsha=${candidate.sha}\n`);
    return;
  }
  const { sourceIdentity } = await import('./acceptance-run.mjs');
  const source = await sourceIdentity(root);
  const files = await candidateFiles(root, resolve(directory));
  const required = await candidatePolicy(root, report);
  refuse(validateCandidateReport(report, { candidate, ...files, source, required }));
  process.stdout.write('Candidate acceptance matches the exact publication files and required outcomes.\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

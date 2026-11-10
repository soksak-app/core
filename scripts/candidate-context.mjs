// Creates the context of a release candidate for `make test-app-candidate` (docs/operations/examples.md#end-to-end-run):
//   GITHUB_TOKEN=<token> node scripts/candidate-context.mjs --repository <owner/name> --run <id> --attempt <n> --out <absolute-new-directory>
// It runs in the clean checkout of the candidate commit. The selected attempt, its required jobs and its immutable artifacts pass the
// same validation as publication (scripts/candidate-acceptance.mjs) before anything is downloaded. The release files of the artifacts
// are written to `<out>/files`, and the bundle of each candidate host is extracted from its release file to `<out>/hosts/<host>` the way
// publication extracts it, so the bundle and executable identities that local acceptance records are those that publication checks.
// `<out>/context.json` then names the candidate, every release file with its digest and every extracted bundle. Nothing is built.
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sourceIdentity } from './acceptance-run.mjs';
import { candidateAssetNames, candidateFiles, prepareCandidate } from './candidate-acceptance.mjs';
import { hashTree } from './candidate-identity.mjs';
import { CANDIDATE_HOSTS, CANDIDATE_PLATFORM } from './candidate-policy.mjs';
import { releaseKey } from './platform/platform.js';

const WORKFLOW = '.github/workflows/release.yml';
const API = 'https://api.github.com/repos';
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const requireValue = (condition, message) => { if (!condition) throw new Error(`candidate context: ${message}`); };
const headers = (token) => ({ Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' });

async function artifactsOf(repository, runId, token, request) {
  const entries = [];
  for (let page = 1; ; page++) {
    const response = await request(`${API}/${repository}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`, { headers: headers(token) });
    requireValue(response.ok, `artifact listing failed: ${response.status}`);
    const { artifacts } = await response.json();
    requireValue(Array.isArray(artifacts), 'artifact listing lacks artifacts');
    entries.push(...artifacts);
    if (artifacts.length < 100) return entries;
  }
}

/** The members of a zip file; each must be one plain file name, because the release files of all artifacts share one folder. */
function flatMembers(zip) {
  const members = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  requireValue(members.length > 0 && members.every((member) => !member.includes('/') && !member.includes('\\') && member !== '..'),
    `${zip}: an artifact must hold only release files`);
  return members;
}

/**
 * Writes `<out>/context.json` of the release candidate `runId`/`runAttempt` of `repository`, built from the checkout `root`, and
 * returns the context. `out` must be an absolute directory that does not exist; existing data is never overwritten.
 */
export async function createCandidateContext({ root, repository, runId, runAttempt, out, token, request = fetch }) {
  requireValue(/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''), 'repository must be <owner>/<name>');
  requireValue(positive(runId) && positive(runAttempt), 'run and attempt must be positive integers');
  requireValue(typeof token === 'string' && token !== '', 'GITHUB_TOKEN is required');
  requireValue(typeof out === 'string' && isAbsolute(out), 'out must be an absolute directory');
  const source = await sourceIdentity(root);
  requireValue(source.dirty === false, 'the candidate checkout is dirty');
  const { version } = await candidateAssetNames(root);
  const listed = await artifactsOf(repository, runId, token, request);
  const artifacts = CANDIDATE_HOSTS.map((host) => {
    const matches = listed.filter((entry) => entry.name === `release-${host}`);
    requireValue(matches.length === 1, `the run must hold exactly one artifact release-${host}`);
    return { id: matches[0].id, name: matches[0].name };
  });
  const candidate = { repository, workflow: WORKFLOW, runId, runAttempt, sha: source.head, version, artifacts };
  // The publication validation of the attempt, its jobs and its artifacts; a failing candidate downloads nothing.
  await prepareCandidate({ candidate }, { root, env: { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token, GITHUB_SHA: source.head }, request });
  await mkdir(out);
  const downloads = join(out, 'downloads');
  const files = join(out, 'files');
  await mkdir(downloads);
  await mkdir(files);
  const seen = new Set();
  for (const artifact of artifacts) {
    const response = await request(`${API}/${repository}/actions/artifacts/${artifact.id}/zip`, { headers: headers(token) });
    requireValue(response.ok, `download of ${artifact.name} failed: ${response.status}`);
    const zip = join(downloads, `${artifact.name}.zip`);
    await writeFile(zip, Buffer.from(await response.arrayBuffer()));
    for (const member of flatMembers(zip)) {
      requireValue(!seen.has(member), `release file ${member} is in more than one artifact`);
      seen.add(member);
    }
    execFileSync('unzip', ['-q', zip, '-d', files], { stdio: 'pipe' });
  }
  await rm(downloads, { recursive: true });
  // The exact release file names, their digests and the identities of their extracted bundles, as publication computes them.
  const { assets, bundles } = await candidateFiles(root, files);
  const hosts = [];
  for (const app of CANDIDATE_HOSTS) {
    const folder = join(out, 'hosts', app);
    await mkdir(folder, { recursive: true });
    execFileSync('unzip', ['-q', join(files, `soksak-${version}-${releaseKey(app, CANDIDATE_PLATFORM)}.zip`), '-d', folder], { stdio: 'pipe' });
    const bundle = join(folder, 'soksak.app');
    requireValue(await hashTree(bundle) === bundles.find((entry) => entry.app === app).bundleSha256, `the extracted ${app} bundle differs from its release file`);
    hosts.push({ app, bundle });
  }
  const context = { schema: 1, candidate, assets: assets.map(({ name, sha256 }) => ({ name, path: join(files, name), sha256 })), hosts };
  await writeFile(join(out, 'context.json'), `${JSON.stringify(context, null, 2)}\n`);
  return context;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ strict: true, options: { repository: { type: 'string' }, run: { type: 'string' }, attempt: { type: 'string' }, out: { type: 'string' } } });
    const root = fileURLToPath(new URL('..', import.meta.url));
    await createCandidateContext({ root, repository: values.repository, runId: Number(values.run), runAttempt: Number(values.attempt),
      out: values.out, token: process.env.GITHUB_TOKEN });
    process.stdout.write(`${join(values.out, 'context.json')}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

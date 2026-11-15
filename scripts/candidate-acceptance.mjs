import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationExecutables, releaseKey } from './platform/platform.js';
import { hashFile, hashTree } from './candidate-identity.mjs';
import { RELEASE_PACKAGES, releaseFileName } from './pack-release-packages.mjs';

/** The hosts of a candidate in sorted order: each has its release job, its release artifact and its applications in the window checks. */
export const CANDIDATE_HOSTS = Object.freeze(['mygo', 'tauriv2', 'wailsv3']);

/** The platform of the candidate release artifacts; the platform operations of the release keys are those of this platform. */
export const CANDIDATE_PLATFORM = Object.freeze({ platform: 'darwin', arch: 'arm64' });

const sorted = (values) => [...values].sort();
const sameSet = (actual, expected) => Array.isArray(actual) && new Set(actual).size === actual.length
  && isDeepStrictEqual(sorted(actual), sorted(expected));

async function jsonFile(path) { return JSON.parse(await readFile(path, 'utf8')); }

/** The exact published release filenames, one bundle of each candidate host and the packages, derived from the candidate's own package declarations. */
export async function candidateAssetNames(root) {
  const manifests = await Promise.all(RELEASE_PACKAGES.map((folder) => jsonFile(join(root, folder, 'package.json'))));
  const version = manifests[0].version;
  if (!/^\d+\.\d+\.\d+$/.test(version) || manifests.some((m) => m.version !== version)) throw new Error('candidate package versions differ');
  return { version, names: [...CANDIDATE_HOSTS.map((host) => `soksak-${version}-${releaseKey(host, CANDIDATE_PLATFORM)}.zip`),
    ...manifests.map((m) => releaseFileName(m.name, version))].sort() };
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

/** `files RELEASE_FILES`: the release job requires the downloaded files of its run to be exactly the release files of the checkout. */
async function main(argv) {
  const [command, directory, ...rest] = argv;
  if (command !== 'files' || !directory || rest.length) throw new Error('usage: candidate-acceptance.mjs files RELEASE_FILES');
  const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
  await candidateFiles(root, resolve(directory));
  process.stdout.write('The release files are exactly the release files of the checkout.\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

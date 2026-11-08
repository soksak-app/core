// Packs the packages that a core release publishes beside its application zips into a folder (docs/operations/examples.md#release):
//   node scripts/pack-release-packages.mjs <destination>
// `pnpm pack` turns a `workspace:` dependency into the version of the named package, which no registry serves. A published
// package therefore names every package of this workspace that it depends on by its release file of the same core release,
// `https://github.com/soksak-app/core/releases/download/v<version>/<file>`, so a plugin repository installs it without core.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryFolder } from './temporary-folder.mjs';

/** The folders of the packages that a core release publishes, in the order they are packed. */
export const RELEASE_PACKAGES = Object.freeze([
  'packages/plugin-api',
  'native/darwin/process-identity',
  'packages/client',
  'packages/log-contract',
  'packages/window-check',
]);

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const RELEASES = 'https://github.com/soksak-app/core/releases/download';

/** The release file of the package `name` at `version`, as `pnpm pack` names it. */
export function releaseFileName(name, version) {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/** The address of the release file of the package `name` in the core release `version`. */
export function releaseUrl(name, version) {
  return `${RELEASES}/v${version}/${releaseFileName(name, version)}`;
}

/**
 * The manifest that the release publishes: the packed manifest with each dependency that the source manifest declares as
 * `workspace:` replaced by the release address of that package. A `workspace:` dependency on a package that the release does
 * not publish is an error, because no address serves it.
 */
export function releaseManifest(packed, source, published) {
  const manifest = structuredClone(packed);
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(source[field] ?? {})) {
      if (!range.startsWith('workspace:')) continue;
      if (!published.has(name)) throw new Error(`${source.name}: ${field} ${name} is a workspace package that the release does not publish`);
      manifest[field][name] = releaseUrl(name, source.version);
    }
  }
  return manifest;
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }

/** Packs each folder of `folders` into `destination` and returns the paths of the release files. */
export function packReleasePackages({ root, destination, folders = RELEASE_PACKAGES, pnpm = 'pnpm' }) {
  const published = new Set(RELEASE_PACKAGES.map((folder) => readJson(join(root, folder, 'package.json')).name));
  mkdirSync(destination, { recursive: true });
  const files = [];
  for (const folder of folders) {
    const source = readJson(join(root, folder, 'package.json'));
    const name = releaseFileName(source.name, source.version);
    const work = temporaryFolder('soksak-release-pack-');
    try {
      execFileSync(pnpm, ['-C', join(root, folder), 'pack', '--pack-destination', work.path], { stdio: ['ignore', 'ignore', 'inherit'] });
      const packed = join(work.path, name);
      execFileSync('tar', ['-xzf', packed, '-C', work.path]);
      const manifestPath = join(work.path, 'package', 'package.json');
      const before = readJson(manifestPath);
      const after = releaseManifest(before, source, published);
      if (JSON.stringify(after) === JSON.stringify(before)) {
        copyFileSync(packed, join(destination, name));
      } else {
        writeFileSync(manifestPath, `${JSON.stringify(after, null, 2)}\n`);
        execFileSync(pnpm, ['-C', join(work.path, 'package'), 'pack', '--pack-destination', resolve(destination)], { stdio: ['ignore', 'ignore', 'inherit'] });
      }
      files.push(join(destination, name));
    } finally {
      work.remove();
    }
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination || process.argv.length !== 3) {
    process.stderr.write('usage: node scripts/pack-release-packages.mjs <destination>\n');
    process.exit(2);
  }
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  for (const file of packReleasePackages({ root, destination: resolve(destination) })) process.stdout.write(`${file}\n`);
}

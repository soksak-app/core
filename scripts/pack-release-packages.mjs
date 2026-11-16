// Packs the packages that a core release publishes beside its application zips into a folder (docs/operations/examples.md#release):
//   node scripts/pack-release-packages.mjs <destination>
// `pnpm pack` turns a `workspace:` dependency into the version of the named package, which no registry serves. A published
// package therefore holds every package of this workspace that it depends on inside its own release file: the dependency is a
// `bundleDependencies` entry and the release file holds `node_modules/<name>` with the files of the release file of that package,
// so a plugin repository installs it without core and with the default settings of pnpm, which refuses a dependency of a
// dependency that a URL names (`blockExoticSubdeps`).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

// A consumer installs `dependencies` and never the `devDependencies` of a dependency, so only these fields can name a workspace package that the release file must hold.
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

/** The release file of the package `name` at `version`, as `pnpm pack` names it. */
export function releaseFileName(name, version) {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/**
 * The manifest that the release publishes: the packed manifest with each dependency that the source manifest declares as
 * `workspace:` listed in `bundleDependencies`, which the release file holds. A `workspace:` dependency on a package that the
 * release does not publish is an error, because no release file holds it, and so is one in `optionalDependencies` or
 * `peerDependencies`, which a bundled copy does not serve. A `devDependencies` entry is not installed by a consumer and stays.
 */
export function releaseManifest(packed, source, published) {
  // `published` maps the name of each published package to its source manifest.
  const manifest = structuredClone(packed);
  const bundled = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(source[field] ?? {})) {
      if (!range.startsWith('workspace:')) continue;
      if (!published.has(name)) throw new Error(`${source.name}: ${field} ${name} is a workspace package that the release does not publish`);
      if (field !== 'dependencies') throw new Error(`${source.name}: ${field} ${name} is a workspace package that the release file cannot hold outside dependencies`);
      bundled.push(name);
    }
  }
  if (bundled.length > 0) manifest.bundleDependencies = bundled;
  // pnpm installs no dependency of a bundled package, so the registry dependencies of each held package become dependencies of this one.
  for (const name of bundled) {
    for (const [dependency, range] of Object.entries(published.get(name).dependencies ?? {})) {
      if (range.startsWith('workspace:')) continue;
      if (manifest.dependencies[dependency] !== undefined && manifest.dependencies[dependency] !== range) {
        throw new Error(`${source.name}: dependencies ${dependency} is ${manifest.dependencies[dependency]} and ${range} in ${name}`);
      }
      manifest.dependencies[dependency] = range;
    }
  }
  return manifest;
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }

/** Puts the files of the release file of the package `name`, packed into `destination` before this one, at `node_modules/<name>` of the package in `work`. */
function holdDependency(destination, work, name, version) {
  const target = join(work, 'package', 'node_modules', name);
  const extracted = join(work, `held-${name.replace('/', '-')}`);
  mkdirSync(extracted, { recursive: true });
  const file = join(destination, releaseFileName(name, version));
  if (!existsSync(file)) throw new Error(`${file}: the release file of ${name} is not packed before the package that holds it`);
  execFileSync('tar', ['-xzf', file, '-C', extracted]);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(join(extracted, 'package'), target);
}

/**
 * The folders of the release package in `folder` and of the release packages that its `workspace:` dependencies name, transitively,
 * in the order of `RELEASE_PACKAGES`: the packages whose release files a consumer of that package needs.
 */
export function releaseClosure(root, folder) {
  const manifests = new Map(RELEASE_PACKAGES.map((entry) => [entry, readJson(join(root, entry, 'package.json'))]));
  const folderOf = new Map([...manifests].map(([entry, manifest]) => [manifest.name, entry]));
  if (!manifests.has(folder)) throw new Error(`${folder}: not a package that the release publishes`);
  const needed = new Set();
  const visit = (entry) => {
    if (needed.has(entry)) return;
    needed.add(entry);
    for (const [name, range] of Object.entries(manifests.get(entry).dependencies ?? {})) {
      if (range.startsWith('workspace:')) visit(folderOf.get(name));
    }
  };
  visit(folder);
  return RELEASE_PACKAGES.filter((entry) => needed.has(entry));
}

/** Packs each folder of `folders` into `destination` and returns the paths of the release files. */
export function packReleasePackages({ root, destination, folders = RELEASE_PACKAGES, pnpm = 'pnpm' }) {
  const published = new Map(RELEASE_PACKAGES.map((folder) => readJson(join(root, folder, 'package.json'))).map((manifest) => [manifest.name, manifest]));
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
        for (const dependency of after.bundleDependencies) holdDependency(destination, work.path, dependency, source.version);
        // `pnpm pack` refuses `bundleDependencies` with the isolated linker of this workspace (ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED),
        // so the release file is the `tar` file of the folder that `pnpm pack` packed, with the held packages added.
        execFileSync('tar', ['-czf', join(destination, name), '-C', work.path, 'package'], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
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

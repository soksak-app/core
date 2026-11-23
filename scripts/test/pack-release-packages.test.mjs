import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packReleasePackages, RELEASE_PACKAGES, releaseClosure, releaseFileName, releaseManifest } from '../pack-release-packages.mjs';
import { temporaryFolder } from '../temporary-folder.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHECK_PACKAGES = ['packages/plugin-api', 'packages/client', 'packages/log-contract', 'packages/window-check'];

test('a release file is named by its package and version', { timeout: 1000 }, () => {
  assert.equal(releaseFileName('@soksak/window-check', '0.0.41'), 'soksak-window-check-0.0.41.tgz');
});

test('a workspace dependency of a published package is held by the release file of the package', { timeout: 1000 }, () => {
  const source = { name: '@soksak/window-check', version: '0.0.41', dependencies: { '@soksak/client': 'workspace:*', ajv: '^8.0.0' }, devDependencies: { '@soksak/log-contract': 'workspace:*' } };
  const packed = { name: '@soksak/window-check', version: '0.0.41', dependencies: { '@soksak/client': '0.0.41', ajv: '^8.0.0' }, devDependencies: { '@soksak/log-contract': '0.0.41' } };
  const manifest = releaseManifest(packed, source, new Map([['@soksak/window-check', source], ['@soksak/client', { name: '@soksak/client', dependencies: { chalk: '^5.0.0' } }], ['@soksak/log-contract', {}]]));
  assert.deepEqual(manifest.bundleDependencies, ['@soksak/client']);
  assert.deepEqual(manifest.dependencies, { '@soksak/client': '0.0.41', ajv: '^8.0.0', chalk: '^5.0.0' });
  assert.equal(packed.bundleDependencies, undefined, 'the packed manifest is not changed in place');
  assert.throws(() => releaseManifest(packed, source, new Map([['@soksak/window-check', source]])), /dependencies @soksak\/client is a workspace package that the release does not publish/);
  const peer = { name: '@soksak/window-check', version: '0.0.41', peerDependencies: { '@soksak/client': 'workspace:*' } };
  assert.throws(() => releaseManifest(peer, peer, new Map([['@soksak/window-check', peer], ['@soksak/client', {}]])), /peerDependencies @soksak\/client is a workspace package that the release file cannot hold/);
});

test('every workspace dependency of a release package is a package that the release publishes', { timeout: 1000 }, () => {
  const manifests = RELEASE_PACKAGES.map((folder) => JSON.parse(readFileSync(join(ROOT, folder, 'package.json'), 'utf8')));
  const published = new Map(manifests.map((manifest) => [manifest.name, manifest]));
  for (const manifest of manifests) assert.doesNotThrow(() => releaseManifest(manifest, manifest, published));
  assert.equal(new Set(manifests.map((manifest) => manifest.version)).size, 1, 'the release packages declare different versions');
});

// The install test packs only the closure of the window check, so it runs on every platform that runs the tests: a release package
// that is restricted to one platform (`os`), such as the macOS process identity package, cannot be packed on another.
test('the release closure of the window check holds no package restricted to a platform', { timeout: 1000 }, () => {
  const closure = releaseClosure(ROOT, 'packages/window-check');
  assert.deepEqual(closure, CHECK_PACKAGES);
  for (const folder of closure) {
    const manifest = JSON.parse(readFileSync(join(ROOT, folder, 'package.json'), 'utf8'));
    assert.equal(manifest.os, undefined, `${folder} is restricted to the platforms ${manifest.os}`);
  }
  assert.throws(() => releaseClosure(ROOT, 'packages/workbench'), /not a package that the release publishes/);
});

// A plugin repository installs @soksak/window-check from the core release, so the packed packages name no workspace version or address
// and hold every module that their exports and bins name.
test('the packed window check packages resolve from the core release and hold their exported modules', { timeout: 60000 }, (t) => {
  const out = temporaryFolder('soksak-release-pack-test-');
  t.after(out.remove);
  const files = packReleasePackages({ root: ROOT, destination: out.path, folders: CHECK_PACKAGES });
  assert.equal(files.length, CHECK_PACKAGES.length);
    for (const file of files) {
    const entries = new Set(execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean));
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', file, 'package/package.json'], { encoding: 'utf8' }));
    assert.equal(file, join(out.path, releaseFileName(manifest.name, manifest.version)));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        assert.doesNotMatch(range, /^workspace:/, `${manifest.name} ${field} ${name} names a workspace version`);
        assert.doesNotMatch(range, /^(https?|file):/, `${manifest.name} ${field} ${name} names a dependency by an address`);
      }
    }
    const targets = [...Object.values(manifest.exports ?? {}), ...Object.values(manifest.bin ?? {})].flatMap((value) => typeof value === 'string' ? [value] : Object.values(value));
    for (const target of targets) {
      const path = posix.join('package', target);
      const held = target.endsWith('/') ? [...entries].some((entry) => entry.startsWith(path)) : entries.has(path);
      assert.ok(held, `${manifest.name} names ${target} that its release file does not hold`);
    }
    if (manifest.name !== '@soksak/window-check') continue;
    // A plugin repository runs its checks with the bin, the catalog of core, the start state and the start probe of the release.
    for (const path of ['catalog.mjs', 'core-events.json', 'start.mjs', 'test-app.mjs', 'sok-test-app.mjs',
      'fixtures/start-probe/plugin.json', 'fixtures/start-probe/package.json', 'fixtures/start-probe/ui/page.html', 'fixtures/start-probe/ui/app.js']) {
      assert.ok(entries.has(`package/${path}`), `@soksak/window-check does not hold ${path}`);
    }
    assert.equal(execFileSync('tar', ['-xzOf', file, 'package/core-events.json'], { encoding: 'utf8' }),
      readFileSync(join(ROOT, 'docs/spec/events.json'), 'utf8'), 'the core catalog of @soksak/window-check differs from docs/spec/events.json');
    assert.equal(manifest.bin['sok-test-app'], './sok-test-app.mjs');
    assert.deepEqual(manifest.bundleDependencies, ['@soksak/client', '@soksak/log-contract', '@soksak/plugin-api']);
    for (const name of manifest.bundleDependencies) {
      assert.ok(entries.has(`package/node_modules/${name}/package.json`), `@soksak/window-check does not hold ${name}`);
    }
  }
});

// pnpm 11 refuses a dependency of a dependency that a URL names (blockExoticSubdeps), so a plugin repository with the default
// settings installs the window check release only when the file holds its workspace dependencies itself.
test('a pnpm project with the default settings installs the window check release and imports its modules', { timeout: 300000 }, (t) => {
  const out = temporaryFolder('soksak-release-install-out-');
  const project = temporaryFolder('soksak-release-install-project-');
  t.after(out.remove);
  t.after(project.remove);
  const files = packReleasePackages({ root: ROOT, destination: out.path, folders: releaseClosure(ROOT, 'packages/window-check') });
  const release = files.find((file) => file.endsWith(releaseFileName('@soksak/window-check', JSON.parse(readFileSync(join(ROOT, 'packages/window-check/package.json'), 'utf8')).version)));
  assert.ok(release, 'the window check release file is not packed');
  writeFileSync(join(project.path, 'package.json'), `${JSON.stringify({ name: 'consumer', private: true, type: 'module', devDependencies: { '@soksak/window-check': `file:${release}` } })}\n`);
  // The settings of the consumer decide the install scripts of the two registry dependencies of the window check: @parcel/watcher runs its
  // script, and koffi runs none, because its package holds the prebuilt binary of each platform; no security setting is lowered.
  writeFileSync(join(project.path, 'pnpm-workspace.yaml'), "allowBuilds:\n  '@parcel/watcher': true\n  koffi: false\n");
  execFileSync('pnpm', ['install', '--prefer-offline'], { cwd: project.path, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, npm_config_user_agent: '' } });
  const imported = execFileSync(process.execPath, ['--input-type=module', '-e',
    "for (const m of ['catalog.mjs', 'start.mjs']) await import(`@soksak/window-check/${m}`); console.log('imported');"], { cwd: project.path, encoding: 'utf8' });
  assert.equal(imported.trim(), 'imported');
});

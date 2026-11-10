import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packReleasePackages, RELEASE_PACKAGES, releaseFileName, releaseManifest, releaseUrl } from '../pack-release-packages.mjs';
import { temporaryFolder } from '../temporary-folder.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHECK_PACKAGES = ['packages/client', 'packages/log-contract', 'packages/window-check'];

test('a release file is addressed by the core release of its version', { timeout: 1000 }, () => {
  assert.equal(releaseFileName('@soksak/window-check', '0.0.41'), 'soksak-window-check-0.0.41.tgz');
  assert.equal(releaseUrl('@soksak/client', '0.0.41'), 'https://github.com/soksak-app/core/releases/download/v0.0.41/soksak-client-0.0.41.tgz');
});

test('a workspace dependency of a published package becomes the release address of that package', { timeout: 1000 }, () => {
  const source = { name: '@soksak/window-check', version: '0.0.41', dependencies: { '@soksak/client': 'workspace:*', ajv: '^8.0.0' }, devDependencies: { '@soksak/log-contract': 'workspace:*' } };
  const packed = { name: '@soksak/window-check', version: '0.0.41', dependencies: { '@soksak/client': '0.0.41', ajv: '^8.0.0' }, devDependencies: { '@soksak/log-contract': '0.0.41' } };
  const manifest = releaseManifest(packed, source, new Set(['@soksak/window-check', '@soksak/client', '@soksak/log-contract']));
  assert.deepEqual(manifest.dependencies, { '@soksak/client': releaseUrl('@soksak/client', '0.0.41'), ajv: '^8.0.0' });
  assert.deepEqual(manifest.devDependencies, { '@soksak/log-contract': releaseUrl('@soksak/log-contract', '0.0.41') });
  assert.equal(packed.dependencies['@soksak/client'], '0.0.41', 'the packed manifest is not changed in place');
  assert.throws(() => releaseManifest(packed, source, new Set(['@soksak/window-check', '@soksak/log-contract'])), /dependencies @soksak\/client is a workspace package that the release does not publish/);
});

test('every workspace dependency of a release package is a package that the release publishes', { timeout: 1000 }, () => {
  const manifests = RELEASE_PACKAGES.map((folder) => JSON.parse(readFileSync(join(ROOT, folder, 'package.json'), 'utf8')));
  const published = new Set(manifests.map((manifest) => manifest.name));
  for (const manifest of manifests) assert.doesNotThrow(() => releaseManifest(manifest, manifest, published));
  assert.equal(new Set(manifests.map((manifest) => manifest.version)).size, 1, 'the release packages declare different versions');
});

// A plugin repository installs @soksak/window-check from the core release, so the packed packages name no workspace version
// and hold every module that their exports and bins name.
test('the packed window check packages resolve from the core release and hold their exported modules', { timeout: 60000 }, (t) => {
  const out = temporaryFolder('soksak-release-pack-test-');
  t.after(out.remove);
  const files = packReleasePackages({ root: ROOT, destination: out.path, folders: CHECK_PACKAGES });
  assert.equal(files.length, CHECK_PACKAGES.length);
  const published = new Set(RELEASE_PACKAGES.map((folder) => JSON.parse(readFileSync(join(ROOT, folder, 'package.json'), 'utf8')).name));
  for (const file of files) {
    const entries = new Set(execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean));
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', file, 'package/package.json'], { encoding: 'utf8' }));
    assert.equal(file, join(out.path, releaseFileName(manifest.name, manifest.version)));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        assert.doesNotMatch(range, /^workspace:/, `${manifest.name} ${field} ${name} names a workspace version`);
        if (published.has(name)) assert.equal(range, releaseUrl(name, manifest.version), `${manifest.name} ${field} ${name} is not its release address`);
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
    assert.ok(entries.has('package/catalog.mjs') && manifest.dependencies['@soksak/plugin-api'] === releaseUrl('@soksak/plugin-api', manifest.version),
      '@soksak/window-check names @soksak/plugin-api by its release address');
  }
});

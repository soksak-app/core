import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { processExecutable, releasePlatform } from '../platform/platform.js';

test('application update registry fixtures select the declared release platform without architecture fallback', { timeout: 10000 }, () => {
  for (const fixture of ['operation-chains.test.mjs', 'app-update.test.mjs']) {
    const source = readFileSync(new URL(`../../e2e/${fixture}`, import.meta.url), 'utf8');
    const declaration = source.match(/const key = ([^;]+);/);
    assert.ok(declaration, `${fixture}: missing registry release key`);
    const key = (platform, arch, name) => runInNewContext(declaration[1], {
      process: { platform, arch }, app: { name },
      releasePlatform: () => releasePlatform({ platform, arch }),
    });
    for (const [platform, os] of [['darwin', 'darwin'], ['linux', 'linux'], ['win32', 'windows']]) {
      for (const arch of ['arm64', 'x64']) {
        for (const host of ['wailsv3', 'tauriv2', 'mygo']) {
          assert.equal(key(platform, arch, host), `${os}-${arch}-${host}`, `${fixture}: ${platform}-${arch}-${host}`);
        }
      }
    }
    assert.throws(() => key('unknown', 'arm64', 'mygo'), /unavailable/, fixture);
    assert.throws(() => key('darwin', 'unknown', 'mygo'), /unavailable/, fixture);
  }
});

test('release platform keys match declared operating systems and architectures', { timeout: 10000 }, () => {
  for (const [platform, os] of [['darwin', 'darwin'], ['linux', 'linux'], ['win32', 'windows']]) {
    for (const arch of ['arm64', 'x64']) assert.equal(releasePlatform({ platform, arch }), `${os}-${arch}`);
  }
  assert.throws(() => releasePlatform({ platform: 'unknown', arch: 'arm64' }), /unavailable/);
  assert.throws(() => releasePlatform({ platform: 'darwin', arch: 'unknown' }), /unavailable/);
});

test('evidence dispatch refuses unsupported and unknown process platforms explicitly', { timeout: 10000 }, async () => {
  for (const platform of ['linux', 'win32', 'unknown', '__proto__']) {
    await assert.rejects(() => processExecutable(1, { platform }), new RegExp(`identity unavailable on ${platform}`));
  }
});

test('metadata-only evidence remains importable on a platform without process lookup', { timeout: 10000 }, () => {
  const selector = new URL('../platform/platform.js', import.meta.url).href;
  const evidence = new URL('../test-evidence.mjs', import.meta.url).href;
  const script = `Object.defineProperty(process, 'platform', { value: 'linux' });
const selected = await import(${JSON.stringify(selector)});
const evidence = await import(${JSON.stringify(evidence)});
if (typeof evidence.collectEvidence !== 'function') throw Error('missing metadata collector');
if (selected.releasePlatform() !== 'linux-' + process.arch) throw Error('incorrect runtime release platform');
try { await selected.processExecutable(process.pid); throw Error('unsupported lookup passed'); }
catch (error) { if (!error.message.includes('identity unavailable on linux')) throw error; }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

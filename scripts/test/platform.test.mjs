import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { applicationBundle, artifactExecutables, crashReports, lockReleaseCommand, nativeEndToEndCommand, PlatformOperationNotImplemented,
  processExecutable, processTableCommand, quitShortcut, releaseKey, releasePlatform } from '../platform/platform.js';
import { processExecutable as linuxProcessExecutable } from '../platform/linux/process-executable.mjs';

const notImplemented = (operation, platform) => ({ name: 'PlatformOperationNotImplemented', message: `${operation} is not implemented on ${platform}` });

test('application update registry fixtures select the declared release platform without architecture fallback', { timeout: 10000 }, () => {
  for (const fixture of ['operation-chains.test.mjs', 'app-update.test.mjs']) {
    const source = readFileSync(new URL(`../../e2e/${fixture}`, import.meta.url), 'utf8');
    const declaration = source.match(/const key = ([^;]+);/);
    assert.ok(declaration, `${fixture}: missing registry release key`);
    const key = (platform, arch, name) => runInNewContext(declaration[1], {
      process: { platform, arch }, app: { name },
      releasePlatform: () => releasePlatform({ platform, arch }),
      releaseKey: (host) => releaseKey(host, { platform, arch }),
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

test('operation chains take the registry release key from the platform declaration, never from a platform literal', { timeout: 10000 }, () => {
  for (const fixture of ['operation-chains.test.mjs', 'app-update.test.mjs']) {
    const source = readFileSync(new URL(`../../e2e/${fixture}`, import.meta.url), 'utf8');
    assert.equal(source.match(/const key = ([^;]+);/)?.[1], 'releaseKey(app.name)', fixture);
    assert.match(source, /import \{ releaseKey \} from "\.\.\/scripts\/platform\/platform\.js";/, fixture);
    assert.doesNotMatch(source, /darwin|linux|win32|macos/i, fixture);
  }
});

test('release platform keys match declared operating systems and architectures', { timeout: 10000 }, () => {
  for (const [platform, os] of [['darwin', 'darwin'], ['linux', 'linux'], ['win32', 'windows']]) {
    for (const arch of ['arm64', 'x64']) assert.equal(releasePlatform({ platform, arch }), `${os}-${arch}`);
  }
  assert.throws(() => releasePlatform({ platform: 'unknown', arch: 'arm64' }), /unavailable/);
  assert.throws(() => releasePlatform({ platform: 'darwin', arch: 'unknown' }), /unavailable/);
});

test('the macOS application artifact declares the bundle, its executables and its release key', { timeout: 10000 }, () => {
  assert.equal(applicationBundle('/work/target/debug', 'mygo', { platform: 'darwin' }), '/work/target/debug/sok-mygo.app');
  assert.deepEqual(artifactExecutables('/candidate/soksak.app', 'tauriv2', { platform: 'darwin' }),
    { application: '/candidate/soksak.app/Contents/MacOS/sok-tauriv2', installer: '/candidate/soksak.app/Contents/MacOS/sok' });
  assert.equal(releaseKey('wailsv3', { platform: 'darwin', arch: 'arm64' }), 'darwin-arm64-wailsv3');
  assert.deepEqual(quitShortcut({ platform: 'darwin' }), { name: 'Command+Q', menuKey: 'cmd+q', key: 'q', text: 'q', modifiers: ['command'] });
  assert.deepEqual(nativeEndToEndCommand('test-app', { platform: 'darwin' }), ['make', '-C', 'native/darwin', 'test-app']);
  assert.deepEqual(lockReleaseCommand('/c/process.lock', 60, { platform: 'darwin' }), ['lockf', '-s', '-t', '60', '/c/process.lock', 'true']);
  assert.deepEqual(processTableCommand({ platform: 'darwin' }), ['ps', '-axo', 'pid=,command=']);
  assert.deepEqual(crashReports('mygo', 0, { platform: 'darwin', folder: '/nonexistent/soksak-crash-reports' }), []);
});

test('an unimplemented platform operation throws its named error when it is called', { timeout: 10000 }, () => {
  const operations = [
    ['application artifact', (platform) => applicationBundle('/work/target/debug', 'mygo', { platform })],
    ['application artifact executables', (platform) => artifactExecutables('/work/sok-mygo', 'mygo', { platform })],
    ['quit shortcut', (platform) => quitShortcut({ platform })],
    ['native end-to-end tests', (platform) => nativeEndToEndCommand('test-app', { platform })],
    ['lock release wait', (platform) => lockReleaseCommand('/c/process.lock', 60, { platform })],
    ['process table', (platform) => processTableCommand({ platform })],
    ['crash reports', (platform) => crashReports('mygo', 0, { platform })],
  ];
  for (const platform of ['linux', 'win32', 'unknown', '__proto__']) {
    for (const [operation, call] of operations) {
      assert.throws(() => call(platform), notImplemented(operation, platform), `${operation} on ${platform}`);
      assert.throws(() => call(platform), PlatformOperationNotImplemented);
    }
  }
});

test('evidence dispatch refuses unsupported and unknown process platforms explicitly', { timeout: 10000 }, async () => {
  for (const platform of ['win32', 'unknown', '__proto__']) {
    await assert.rejects(() => processExecutable(1, { platform }), notImplemented('process executable identity', platform));
  }
});

test('linux process identity reads the executable link of the live PID', { timeout: 10000 }, async () => {
  const links = [];
  const readLink = async (path) => { links.push(path); return '/opt/soksak/sok-mygo '; };
  assert.equal(await processExecutable(4242, { platform: 'linux', readLink }), '/opt/soksak/sok-mygo ');
  assert.deepEqual(links, ['/proc/4242/exe']);
  await assert.rejects(() => linuxProcessExecutable(7, { readLink: async () => { throw new Error('ENOENT: no such file or directory'); } }),
    /^Error: process executable identity unavailable for PID 7: ENOENT: no such file or directory$/);
});

test('metadata-only evidence remains importable on a platform without process lookup', { timeout: 10000 }, () => {
  const selector = new URL('../platform/platform.js', import.meta.url).href;
  const evidence = new URL('../test-evidence.mjs', import.meta.url).href;
  const script = `Object.defineProperty(process, 'platform', { value: 'win32' });
const selected = await import(${JSON.stringify(selector)});
const evidence = await import(${JSON.stringify(evidence)});
if (typeof evidence.collectEvidence !== 'function') throw Error('missing metadata collector');
if (selected.releasePlatform() !== 'windows-' + process.arch) throw Error('incorrect runtime release platform');
try { await selected.processExecutable(process.pid); throw Error('unsupported lookup passed'); }
catch (error) { if (error.message !== 'process executable identity is not implemented on win32') throw error; }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

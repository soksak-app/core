import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { applicationArtifact, applicationExecutables, crashReports, listProcesses, openApplication, PlatformOperationNotImplemented, processExecutable,
  processStacks, quitApplication, releaseKey, releasePlatform, runNativeTests, waitForLockRelease } from '../platform/platform.js';
import { processExecutable as linuxProcessExecutable } from '../platform/linux/process-executable.mjs';

const notImplemented = (operation, platform) => ({ name: 'PlatformOperationNotImplemented', message: `${operation} is not implemented on ${platform}` });

/** Each operation of the common selector with arguments, called for `platform`. */
const OPERATIONS = [
  ['applicationArtifact', (platform) => applicationArtifact('/work/target/debug', 'mygo', { platform })],
  ['applicationExecutables', (platform) => applicationExecutables('/work/artifact', 'mygo', { platform })],
  ['quitApplication', (platform) => quitApplication({ request: async () => { throw new Error('no request is sent'); } }, 'menu', { platform })],
  ['waitForLockRelease', (platform) => waitForLockRelease('/c/process.lock', 60, { platform })],
  ['listProcesses', (platform) => listProcesses({ platform })],
  ['runNativeTests', (platform) => runNativeTests('test-app', { platform })],
  ['crashReports', (platform) => crashReports('mygo', 0, { platform })],
  ['openApplication', (platform) => openApplication('/work/sok-mygo', { platform })],
  ['processStacks', (platform) => processStacks(1, '/work/stacks.txt', { platform })],
];

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

test('the macOS application artifact gives neutral executables and its release key', { timeout: 10000 }, async () => {
  const artifact = await applicationArtifact('/work/target/debug', 'mygo', { platform: 'darwin' });
  assert.equal(artifact, '/work/target/debug/sok-mygo.app');
  assert.deepEqual(await applicationExecutables(artifact, 'mygo', { platform: 'darwin' }),
    { application: '/work/target/debug/sok-mygo.app/Contents/MacOS/sok-mygo', sok: '/work/target/debug/sok-mygo.app/Contents/MacOS/sok' });
  assert.equal(releaseKey('wailsv3', { platform: 'darwin', arch: 'arm64' }), 'darwin-arm64-wailsv3');
  assert.deepEqual(await crashReports('mygo', 0, { platform: 'darwin', folder: '/nonexistent/soksak-crash-reports' }), []);
});

test('a quit asks the application through the endpoint and returns the name of the action, on the menu and on the key', { timeout: 10000 }, async () => {
  const requests = [];
  const client = { async request(method, params) {
    requests.push([method, params]);
    if (method === 'status.get') return { menus: [{ title: 'soksak', items: [{ title: 'Quit soksak', key: 'cmd+q' }] }] };
    if (method === 'windows.list') return [{ window: 'w1' }];
    return null;
  } };
  assert.equal(await quitApplication(client, 'menu', { platform: 'darwin' }), 'the item Quit soksak');
  assert.equal(await quitApplication(client, 'key', { platform: 'darwin' }), 'Command+Q');
  assert.deepEqual(requests.map(([method]) => method), ['status.get', 'command.run', 'windows.list', 'input.key', 'input.key']);
  await assert.rejects(() => quitApplication(client, 'shortcut', { platform: 'darwin' }), /unknown quit path "shortcut"/);
});

for (const platform of ['linux', 'win32']) {
  test(`${platform}: the common selector imports, and each operation that ${platform} does not implement rejects with its named error when called`, { timeout: 10000 }, () => {
    const selector = new URL('../platform/platform.js', import.meta.url).href;
    const script = `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
const selected = await import(${JSON.stringify(selector)});
const calls = {
  applicationArtifact: () => selected.applicationArtifact('/work/target/debug', 'mygo'),
  applicationExecutables: () => selected.applicationExecutables('/work/artifact', 'mygo'),
  quitApplication: () => selected.quitApplication({ request: async () => { throw Error('no request is sent'); } }, 'menu'),
  waitForLockRelease: () => selected.waitForLockRelease('/c/process.lock', 60),
  listProcesses: () => selected.listProcesses(),
  runNativeTests: () => selected.runNativeTests('test-app'),
  crashReports: () => selected.crashReports('mygo', 0),
  openApplication: () => selected.openApplication('/work/sok-mygo'),
  processStacks: () => selected.processStacks(1, '/work/stacks.txt'),
};
const results = {};
for (const [name, call] of Object.entries(calls)) {
  try { await call(); results[name] = 'passed'; }
  catch (error) { results[name] = (error instanceof selected.PlatformOperationNotImplemented ? 'named ' : 'other ') + error.message; }
}
process.stdout.write(JSON.stringify(results));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), Object.fromEntries(OPERATIONS.map(([operation]) =>
      [operation, `named ${operation} is not implemented on ${platform}`])));
  });
}

test('an unimplemented platform operation rejects with its named error when it is called', { timeout: 10000 }, async () => {
  for (const platform of ['linux', 'win32', 'unknown', '__proto__']) {
    for (const [operation, call] of OPERATIONS) {
      await assert.rejects(() => call(platform), notImplemented(operation, platform), `${operation} on ${platform}`);
      await assert.rejects(() => call(platform), PlatformOperationNotImplemented);
    }
  }
});

test('the common platform modules name no macOS mechanism', { timeout: 10000 }, () => {
  const forbidden = /bundle|shortcut|\bcmd\b|command\+|lockf|\bps\b|Library|\.app\b|keylayout|inputmethod|\bTIS|Contents\/MacOS|Command\+Q/;
  for (const path of ['../platform/platform.js', '../../e2e/platform/platform.js', '../test-app.mjs']) {
    const lines = readFileSync(new URL(path, import.meta.url), 'utf8').split('\n')
      // `item.app` and `host.app` are the application name of a step and of a host entry, not an application bundle.
      .map((line) => line.replace(/\b(item|host)\.app\b/g, '$1.name'))
      // The candidate and ordinary artifact contexts name the artifact of each host in their declared field `bundle`
      // (docs/operations/examples.md); only that field access and its validation message are allowed.
      .map((line) => line.replace(/\bhost\.bundle\b|\bbundle: `\/candidate\/\$\{app\}`|\$\{host\.name\} bundle must be absolute|\)\.bundle;/g, ''));
    const named = lines.flatMap((line, index) => (forbidden.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : []));
    assert.deepEqual(named, [], path);
  }
});

test('evidence dispatch refuses unsupported and unknown process platforms explicitly', { timeout: 10000 }, async () => {
  for (const platform of ['win32', 'unknown', '__proto__']) {
    await assert.rejects(() => processExecutable(1, { platform }), notImplemented('processExecutable', platform));
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
catch (error) { if (error.message !== 'processExecutable is not implemented on win32') throw error; }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

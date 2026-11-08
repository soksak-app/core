// Verifies that the temporary folder of a run is removed when a signal ends the run, and that the signal still ends the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { temporaryFolder } from '../temporary-folder.mjs';

const helper = new URL('../temporary-folder.mjs', import.meta.url).href;

// Starts a run that holds a temporary folder, ends it by `signal`, and asserts that the folder is gone and the signal ended it.
async function endBySignal(signal) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { temporaryFolder } from ${JSON.stringify(helper)};
    import { writeFileSync } from 'node:fs';
    const folder = temporaryFolder('soksak-temporary-folder-test-');
    try {
      writeFileSync(folder.path + '/binary', 'x');
      process.stdout.write(folder.path + '\\n');
      await new Promise(() => setInterval(() => {}, 1000));
    } finally {
      folder.remove();
    }
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const path = await new Promise((resolve, reject) => {
    child.stdout.once('data', (data) => resolve(String(data).trim()));
    child.once('exit', (code) => reject(new Error(`the run exited with ${code} before it named its folder`)));
  });
  assert.ok(existsSync(path), path);
  const ended = new Promise((resolve) => child.once('exit', (code, received) => resolve({ code, received })));
  child.kill(signal);
  assert.deepEqual(await ended, { code: null, received: signal });
  assert.equal(existsSync(path), false, `${path} remains after ${signal}`);
}

test('a run ended by SIGINT removes its temporary folder and ends by SIGINT', { timeout: 20000 }, () => endBySignal('SIGINT'));
test('a run ended by SIGTERM removes its temporary folder and ends by SIGTERM', { timeout: 20000 }, () => endBySignal('SIGTERM'));
test('a run ended by SIGHUP removes its temporary folder and ends by SIGHUP', { timeout: 20000 }, () => endBySignal('SIGHUP'));

test('a run that returns removes its temporary folder and leaves no signal handler', () => {
  const before = process.listenerCount('SIGTERM');
  const folder = temporaryFolder('soksak-temporary-folder-test-');
  assert.equal(process.listenerCount('SIGTERM'), before + 1);
  folder.remove();
  assert.equal(existsSync(folder.path), false);
  assert.equal(process.listenerCount('SIGTERM'), before);
});

test('the Go test runner and the host contract run take their build folder from temporaryFolder', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of ['scripts/go-tests.mjs', 'scripts/test-hosts.mjs']) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /mkdtempSync\(/, `${file} creates a folder that a signal leaves behind`);
    assert.match(source, /temporaryFolder\('(soksak-go-tests|host-contract)-'\)/, file);
  }
});

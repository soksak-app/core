// The macOS implementation of the end-to-end platform operations: the process list, the lock release wait and the crash reports.
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crashReports, listProcesses, openApplication, parseProcessTable, waitForLockRelease } from '../../../platform/darwin/end-to-end.mjs';

const EXECUTABLE_HEADER = 'E'.repeat(1024);
/** A row of the table that `ps -axww -o pid=PID,ppid=PPID,comm=<header>,args=ARGS` prints. */
const row = (pid, ppid, executable, args) => `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${executable.padEnd(EXECUTABLE_HEADER.length)} ${args}`;

test('listProcesses parses the darwin process table into records, also for an executable path with spaces', { timeout: 10000 }, async () => {
  const table = [
    `  PID  PPID ${EXECUTABLE_HEADER} ARGS`,
    row(1, 0, '/sbin/launchd', '/sbin/launchd'),
    row(534, 1, '/System/Library/CoreServices/Software Update.app/Contents/Resources/softwareupdated', '/System/Library/CoreServices/Software Update.app/Contents/Resources/softwareupdated --flag'),
    row(4242, 534, '/work/target/debug/sok-mygo.app/Contents/MacOS/sok-mygo', '/work/target/debug/sok-mygo.app/Contents/MacOS/sok-mygo --config-dir /work/config dir'),
    '',
  ].join('\n');
  const calls = [];
  const records = await listProcesses({ execute: async (file, args) => { calls.push([file, args]); return { stdout: table }; } });
  assert.deepEqual(calls, [['ps', ['-axww', '-o', `pid=PID,ppid=PPID,comm=${EXECUTABLE_HEADER},args=ARGS`]]]);
  assert.deepEqual(records, [
    { pid: 1, ppid: 0, executable: '/sbin/launchd', arguments: '/sbin/launchd' },
    { pid: 534, ppid: 1, executable: '/System/Library/CoreServices/Software Update.app/Contents/Resources/softwareupdated',
      arguments: '/System/Library/CoreServices/Software Update.app/Contents/Resources/softwareupdated --flag' },
    { pid: 4242, ppid: 534, executable: '/work/target/debug/sok-mygo.app/Contents/MacOS/sok-mygo',
      arguments: '/work/target/debug/sok-mygo.app/Contents/MacOS/sok-mygo --config-dir /work/config dir' },
  ]);
  assert.throws(() => parseProcessTable('  PID  PPID COMMAND ARGS\n    1     0 /sbin/launchd /sbin/launchd'), /the process table has no expected header/);
  assert.throws(() => parseProcessTable(`  PID  PPID ${EXECUTABLE_HEADER} ARGS\nnot a row`), /does not match the table header/);
});

test('waitForLockRelease reports a released lock, a lock still held at its limit, and another end of lockf as an error', { timeout: 10000 }, async () => {
  const runs = [];
  const run = (code, signal = null) => async (spec) => { runs.push(spec); return { code, signal }; };
  assert.equal(await waitForLockRelease('/c/process.lock', 60, { run: run(0) }), true);
  assert.equal(await waitForLockRelease('/c/process.lock', 60, { run: run(75) }), false);
  await assert.rejects(() => waitForLockRelease('/c/process.lock', 60, { run: run(null, 'SIGKILL') }), /^Error: lockf ended with signal SIGKILL$/);
  assert.deepEqual(runs[0], { file: 'lockf', args: ['-s', '-t', '60', '/c/process.lock', 'true'] });
});

test('openApplication opens the bundle that holds the executable through Launch Services and refuses an executable outside a bundle', { timeout: 10000 }, async () => {
  const runs = [];
  await openApplication('/work/target/debug/sok-mygo.app/Contents/MacOS/sok-mygo', { run: async (spec) => { runs.push(spec); return { code: 0, signal: null }; } });
  assert.deepEqual(runs, [{ file: 'open', args: ['-a', '/work/target/debug/sok-mygo.app'] }]);
  await assert.rejects(() => openApplication('/work/sok-mygo', { run: async () => { throw new Error('nothing runs'); } }),
    /^Error: the executable \/work\/sok-mygo is not inside an application bundle$/);
  await assert.rejects(() => openApplication('/a.app/Contents/MacOS/a', { run: async () => ({ code: 1, signal: null }) }), /^Error: open ended with code 1$/);
});

test('crashReports returns a record of each report of the application written since the run started', { timeout: 10000 }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'soksak-crash-reports-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const report = join(folder, 'sok-mygo-2026-11-08-120000.ips');
  await writeFile(report, `${JSON.stringify({ app_name: "sok-mygo", bug_type: "309" })}\n${JSON.stringify({
    exception: { type: "EXC_BAD_ACCESS", signal: "SIGSEGV", rawCodes: [1, 8] }, faultingThread: 0,
    threads: [{ threadState: { pc: { value: 0x100000040 } } }],
    usedImages: [{ name: "sok-mygo", path: "/work/sok-mygo", arch: "arm64", base: 0x100000000, size: 0x1000000 }],
  })}`);
  await writeFile(join(folder, 'sok-tauriv2-2026-11-08-120000.ips'), '{}\n{}');
  const old = join(folder, 'sok-mygo-2026-11-01-120000.ips');
  await writeFile(old, '{}\n{}');
  await utimes(old, new Date(1000), new Date(1000));
  const records = crashReports('mygo', 10_000, { folder });
  assert.deepEqual(records.map((record) => record.report), [report]);
  assert.deepEqual(records[0].fault, { thread: "thread 0", image: "sok-mygo", path: "/work/sok-mygo", arch: "arm64", load: "0x100000000", address: "0x100000040" });
});

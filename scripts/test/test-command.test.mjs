import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { untilFolderState } from '@soksak/window-check/folder-wait.mjs';
import { runCommand } from '../test-command.mjs';

const node = process.execPath;
const task = (source) => [node, ['-e', source]];
// A command that ends on its own gets this limit, so the limit only bounds a hang and never decides the result under load.
const hangMs = 60_000;
// The per-test limit of such a test is above the command limit and also only bounds a hang.
const testHangMs = 70_000;
// A child that stays until a signal ends it, so a limit, a cancellation or a heartbeat always comes before its end.
const forever = 'setInterval(() => {}, 1000)';

// An ended process remains a zombie until its parent reaps it, and kill(pid, 0) on a zombie succeeds. So the judgment uses the state in the process table.
// This file uses the function as imported, not childProcess.execFileSync, which other tests of this file replace.
function assertEnded(pid) {
  let state;
  try {
    state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch (error) {
    if (error.status === 1 && error.stdout === '') return;
    throw error;
  }
  assert.match(state, /^Z/, `process ${pid} is running with state ${state}`);
}

test('emits ordered start and terminal events with visible output', { timeout: testHangMs }, async () => {
  const events = [];
  const [command, args] = task("console.log('visible-out'); console.error('visible-err')");
  const result = await runCommand({ id: 'ordered', command, args, timeoutMs: hangMs, onEvent: (event) => events.push(event) });
  assert.equal(result.status, 'pass');
  assert.deepEqual(events.map((event) => event.type), ['start', 'pass']);
  assert.deepEqual(events.at(-1), { type: 'pass', id: 'ordered', elapsedMs: events.at(-1).elapsedMs, exitCode: 0, signal: null, error: null, cleanupObservations: [] });
  assert.match(result.stdout, /visible-out/);
  assert.match(result.stderr, /visible-err/);
  assert.ok(events.every((event) => event.id === 'ordered' && Number.isFinite(event.elapsedMs)));
});

test('preserves UTF-8 stdout and stderr across split byte chunks', { timeout: testHangMs }, async () => {
  const source = "const out=Buffer.from('한글\\n'); const err=Buffer.from('오류\\n'); process.stdout.write(out.subarray(0,1)); process.stderr.write(err.subarray(0,1)); setTimeout(() => { process.stdout.write(out.subarray(1)); process.stderr.write(err.subarray(1)); }, 10);";
  const [command, args] = task(source);
  const result = await runCommand({ id: 'utf8-split', command, args, timeoutMs: hangMs, onEvent: () => {} });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(result.stdout, '한글\n');
  assert.equal(result.stderr, '오류\n');
});

test('emits heartbeat progress while the command runs', { timeout: testHangMs }, async () => {
  const events = [];
  const controller = new AbortController();
  const [command, args] = task(forever);
  // The child stays until it is cancelled, and the first progress event cancels it, so the result shows the heartbeat.
  const result = await runCommand({ id: 'heartbeat', command, args, timeoutMs: hangMs, heartbeatMs: 30, signal: controller.signal, onEvent: (event) => {
    events.push(event);
    if (event.type === 'progress') controller.abort();
  } });
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  // The child runs until the group ends after the cancel, and each heartbeat of that time is a progress event, so the
  // number of progress events depends on the time the end takes; the order start, progress, cancelled does not.
  const types = events.map((event) => event.type);
  assert.deepEqual([types[0], types[1], types.at(-1)], ['start', 'progress', 'cancelled'], JSON.stringify(types));
  assert.ok(types.slice(1, -1).every((type) => type === 'progress'), JSON.stringify(types));
});

test('reports nonzero exit as fail', { timeout: testHangMs }, async () => {
  const [command, args] = task('process.exit(7)');
  const result = await runCommand({ id: 'nonzero', command, args, timeoutMs: hangMs, onEvent: () => {} });
  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 7);
});

test('reports an absent executable as fail with an error', { timeout: testHangMs }, async () => {
  const events = [];
  const result = await runCommand({ id: 'enoent', command: 'definitely-not-a-command', args: [], timeoutMs: hangMs, onEvent: (event) => events.push(event) });
  assert.equal(result.status, 'fail');
  assert.equal(result.error.code, 'ENOENT');
  assert.equal(events.at(-1).error.code, 'ENOENT');
});

test('a forced kill after the child already ended on SIGTERM still reports timeout', { timeout: 10000 }, async () => {
  // Makes the SIGKILL after 100 ms run while the loop has not yet handled the end of a child that ended with SIGTERM. It is the same order as when the loop is
  // late under load. macOS can reject with EPERM a signal sent to a process group in which only ended children remain.
  const [command, args] = task(forever);
  let held = false;
  const result = await runCommand({
    id: 'late-exit', command, args, timeoutMs: 50, heartbeatMs: 50,
    onEvent: (event) => {
      if (event.type !== 'progress' || held) return;
      held = true;
      const until = performance.now() + 150;
      while (performance.now() < until) { /* holds the loop */ }
    },
  });
  assert.equal(held, true, 'the progress event did not hold the loop');
  assert.equal(result.status, 'timeout', JSON.stringify({ error: result.error, signal: result.signal }));
});

test('a refused forced kill of a group that ended on SIGTERM still reports timeout', { timeout: 10000 }, async (t) => {
  // Injects the case in which macOS rejects with EPERM the SIGKILL sent after 100 ms to a group that ended with SIGTERM. The cleanup step checks whether the group is gone,
  // so a rejected forced termination alone does not fail.
  const originalKill = process.kill;
  t.after(() => { process.kill = originalKill; });
  process.kill = (pid, signal) => {
    if (pid < 0 && signal === 'SIGKILL') {
      const error = new Error('kill EPERM');
      error.code = 'EPERM';
      throw error;
    }
    return originalKill(pid, signal);
  };
  // The child receives SIGTERM and ends 120 ms later. So the forced termination after 100 ms runs first and receives the injected rejection. The 300 ms
  // limit makes SIGTERM arrive after the child has installed its handler.
  const [command, args] = task("process.on('SIGTERM', () => setTimeout(() => process.exit(0), 120)); setInterval(() => {}, 1000)");
  const result = await runCommand({ id: 'refused-kill', command, args, timeoutMs: 300, onEvent: () => {} });
  assert.equal(result.status, 'timeout', JSON.stringify({ error: result.error }));
});

test('times out and reports timeout', { timeout: 2000 }, async () => {
  const events = [];
  const [command, args] = task(forever);
  const result = await runCommand({ id: 'timeout', command, args, timeoutMs: 50, heartbeatMs: 20, onEvent: (event) => events.push(event) });
  assert.equal(result.status, 'timeout');
  assert.equal(events.at(-1).type, 'timeout');
  assert.equal(events.at(-1).exitCode, null);
  assert.equal(events.at(-1).signal, 'SIGTERM');
  assert.equal(events.at(-1).error, null);
});

test('cancels and reports cancelled', { timeout: testHangMs }, async () => {
  const controller = new AbortController();
  const events = [];
  const [command, args] = task(forever);
  // The start event cancels the command, so the cancellation comes before the limit at any load.
  const result = await runCommand({ id: 'cancel', command, args, timeoutMs: hangMs, signal: controller.signal, onEvent: (event) => {
    events.push(event);
    if (event.type === 'start') controller.abort();
  } });
  assert.equal(result.status, 'cancelled');
  assert.equal(events.at(-1).type, 'cancelled');
  assert.equal(events.at(-1).error, null);
});

test('cleans descendants after the leader exits', { timeout: testHangMs }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'test-command-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = join(directory, 'pid');
  const source = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.exit(0);`;
  const [command, args] = task(source);
  const result = await runCommand({ id: 'descendant', command, args, timeoutMs: hangMs, onEvent: () => {} });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  const descendantPid = Number(await readFile(pidFile, 'utf8'));
  assertEnded(descendantPid);
});

test('cleans a descendant that inherits supervisor stdio before close', { timeout: testHangMs }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'test-command-inherit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = join(directory, 'pid');
  const source = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.exit(0);`;
  const [command, args] = task(source);
  const result = await runCommand({ id: 'inherited-stdio', command, args, timeoutMs: hangMs, onEvent: () => {} });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  const descendantPid = Number(await readFile(pidFile, 'utf8'));
  assertEnded(descendantPid);
});

// The command ends when the descendant reports readiness, so its timeout only bounds process startup under load and is not the behavior under test.
test('escalates cleanup for a descendant that ignores SIGTERM', { timeout: testHangMs }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'test-command-resistant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = join(directory, 'pid');
  const markerFile = join(directory, 'term');
  let descendantPid;
  t.after(async () => {
    if (!descendantPid) {
      try { descendantPid = Number(await readFile(pidFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (descendantPid) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  });
  const descendantSource = `const {writeFileSync}=require('node:fs'); process.on('SIGTERM',()=>writeFileSync(${JSON.stringify(markerFile)},'term')); process.send('ready'); setInterval(()=>{},1000);`;
  const source = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{stdio:['ignore','ignore','ignore','ipc']}); child.on('message',message=>{if(message==='ready'){writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.exit(0);}});`;
  const [command, args] = task(source);
  const result = await runCommand({ id: 'resistant-descendant', command, args, timeoutMs: hangMs, onEvent: () => {} });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  descendantPid = Number(await readFile(pidFile, 'utf8'));
  assert.equal(await readFile(markerFile, 'utf8'), 'term');
  assertEnded(descendantPid);
});

test('turns an event callback exception into a failure and cleans the child', { timeout: testHangMs }, async () => {
  const events = [];
  const [command, args] = task(forever);
  const result = await runCommand({ id: 'callback-error', command, args, timeoutMs: hangMs, heartbeatMs: 20, onEvent: (event) => {
    if (event.type === 'progress') throw new Error('event callback failed');
    events.push(event);
  } });
  assert.equal(result.status, 'fail');
  assert.equal(result.error.message, 'event callback failed');
  assert.equal(events.at(-1).type, 'fail');
});

test('reports a terminal observer exception instead of claiming success', { timeout: testHangMs }, async () => {
  const [command, args] = task('process.stdout.write(\'output-before-terminal\')');
  const result = await runCommand({ id: 'terminal-callback-error', command, args, timeoutMs: hangMs, onEvent: (event) => {
    if (event.type === 'pass') throw new Error('terminal observer failed');
  } });
  assert.equal(result.status, 'fail');
  assert.equal(result.error.message, 'terminal observer failed');
});

test('reports process-group signal failure without an unhandled timer error', { timeout: 2000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'test-command-signal-'));
  const pidFile = join(directory, 'pid');
  const originalKill = process.kill;
  t.after(async () => {
    process.kill = originalKill;
    try { originalKill(-Number(await readFile(pidFile, 'utf8')), 'SIGKILL'); } catch {}
    await rm(directory, { recursive: true, force: true });
  });
  process.kill = (pid, signal) => {
    if (pid < 0 && signal !== 0) {
      const error = new Error('blocked process-group signal');
      error.code = 'EPERM';
      throw error;
    }
    return originalKill(pid, signal);
  };
  const source = `const {writeFileSync}=require('node:fs'); writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000);`;
  const [command, args] = task(source);
  const result = await runCommand({ id: 'signal-error', command, args, timeoutMs: 20, onEvent: () => {} });
  assert.equal(result.status, 'fail');
  assert.equal(result.error.code, 'EPERM');
  // Keeps the failed signal and the process group. The next occurrence shows which step's signal it was.
  assert.match(result.error.message, /^SIGTERM to process group \d+: blocked process-group signal$/);
});

test('forwards CLI SIGTERM to command cancellation and cleanup', { timeout: testHangMs }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'test-command-cli-signal-'));
  const pidFile = join(directory, 'pid');
  const markerFile = join(directory, 'term');
  let descendantPid;
  let cli;
  t.after(async () => {
    if (cli?.pid) {
      try { process.kill(cli.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (!descendantPid) {
      try { descendantPid = Number(await readFile(pidFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (descendantPid) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const descendantSource = `const {writeFileSync}=require('node:fs'); process.on('SIGTERM',()=>writeFileSync(${JSON.stringify(markerFile)},'term')); process.send('ready'); setInterval(()=>{},1000);`;
  // The pid file is created by writing a temporary file and renaming it. The reader never reads an empty file in the middle of the write.
  const commandSource = `const {spawn}=require('node:child_process'); const {renameSync,writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{stdio:['ignore','ignore','ignore','ipc']}); child.on('message',message=>{if(message==='ready'){writeFileSync(${JSON.stringify(pidFile + '.tmp')},String(child.pid)); renameSync(${JSON.stringify(pidFile + '.tmp')},${JSON.stringify(pidFile)});}}); setInterval(()=>{},1000);`;
  // The pid file is read once the watch of the folder is active and again at each change, so its rename is seen at any load.
  const ready = untilFolderState(directory, () => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : undefined), hangMs,
    () => new Error(`${pidFile} was not written within ${hangMs} ms`));
  cli = spawn(node, [join(process.cwd(), 'scripts/test-command.mjs'), '--id', 'cli-signal', '--timeout-ms', String(hangMs), '--', node, '-e', commandSource], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  cli.stdout.on('data', (chunk) => { stdout += chunk; });
  // The rename of the pid file is the readiness event.
  descendantPid = Number(await ready);
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0, `pid file holds ${descendantPid}`);
  cli.kill('SIGTERM');
  const closeResult = await new Promise((resolve) => cli.once('close', (code, signal) => resolve({ code, signal })));
  assert.equal(closeResult.code, 1);
  assert.match(stdout, /"type":"cancelled"/);
  assert.equal(await readFile(markerFile, 'utf8'), 'term');
  assertEnded(descendantPid);
});

test('rejects invalid arguments', { timeout: 2000 }, () => {
  assert.throws(() => runCommand({ id: '', command: node, args: [], timeoutMs: 1, onEvent: () => {} }), /id/);
  assert.throws(() => runCommand({ id: 'bad-timeout', command: node, args: [], timeoutMs: 0, onEvent: () => {} }), /timeoutMs/);
  assert.throws(() => runCommand({ id: 'fractional-timeout', command: node, args: [], timeoutMs: 1.5, onEvent: () => {} }), /timeoutMs/);
  assert.throws(() => runCommand({ id: 'large-timeout', command: node, args: [], timeoutMs: 600001, onEvent: () => {} }), /timeoutMs/);
  assert.throws(() => runCommand({ id: 'large-heartbeat', command: node, args: [], timeoutMs: 1, heartbeatMs: 5001, onEvent: () => {} }), /heartbeatMs/);
  assert.throws(() => runCommand({ id: 'bad-command', command: '', args: [], timeoutMs: 1, onEvent: () => {} }), /command/);
  assert.throws(() => runCommand({ id: 'bad-callback', command: node, args: [], timeoutMs: 1, onEvent: true }), /onEvent/);
  assert.throws(() => runCommand({ id: 'bad-signal', command: node, args: [], timeoutMs: 1, signal: {} }), /signal/);
});

test('does not convert denied cleanup verification after SIGKILL into success', { timeout: testHangMs }, async (t) => {
  // Injects the state in which the check is rejected and the process table shows a running member. This user cannot send a signal to that member.
  const originalKill = process.kill;
  const originalExecFileSync = childProcess.execFileSync;
  let killAttempted = false;
  let group;
  t.after(() => {
    process.kill = originalKill;
    childProcess.execFileSync = originalExecFileSync;
  });
  childProcess.execFileSync = (file, args, options) => {
    if (file !== 'ps') return originalExecFileSync(file, args, options);
    return `${group} ${group} S\n`;
  };
  process.kill = (pid, signal) => {
    if (pid < 0) group = -pid;
    if (pid < 0 && signal === 'SIGKILL') { killAttempted = true; return true; }
    if (pid < 0 && signal === 0) {
      if (!killAttempted) return true;
      const error = new Error('cleanup verification denied');
      error.code = 'EPERM';
      throw error;
    }
    return originalKill(pid, signal);
  };
  const result = await runCommand({ id: 'denied-verification', command: node, args: ['-e', 'process.exit(0)'], timeoutMs: hangMs, onEvent: () => {} });
  assert.equal(result.status, 'fail', JSON.stringify(result));
  assert.equal(result.error.code, 'EPERM');
  assert.ok(result.cleanupObservations.some((item) => item.operation === 'verify' && item.error.code === 'EPERM' && item.members.some((member) => member.pid === group && member.state === 'S')), JSON.stringify(result.cleanupObservations));
});

test('counts a process group that holds only zombies as gone after a denied probe', { timeout: testHangMs }, async (t) => {
  // Injects the measured state. For a group in which every member has ended but has not been reaped, kill(-pgid, sig) of macOS returns EPERM, and
  // the process table shows that member as a zombie (Z).
  const originalKill = process.kill;
  const originalExecFileSync = childProcess.execFileSync;
  t.after(() => {
    process.kill = originalKill;
    childProcess.execFileSync = originalExecFileSync;
  });
  let group;
  process.kill = (pid, signal) => {
    if (pid < 0) {
      group = -pid;
      const error = new Error('kill EPERM');
      error.code = 'EPERM';
      throw error;
    }
    return originalKill(pid, signal);
  };
  childProcess.execFileSync = (file, args, options) => {
    if (file !== 'ps') return originalExecFileSync(file, args, options);
    return `    1     1 Ss\n${group + 1} ${group} Z\n`;
  };
  const result = await runCommand({ id: 'zombie-group', command: node, args: ['-e', 'process.exit(0)'], timeoutMs: hangMs, onEvent: () => {} });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.deepEqual(result.cleanupObservations, [{ operation: 'verify', error: { name: 'Error', message: 'kill EPERM', code: 'EPERM' }, members: [{ pid: group + 1, state: 'Z' }] }]);
});

test('reads the members of a group from the real process table after a denied probe', { timeout: testHangMs }, async (t) => {
  // Only the check is rejected, and the process table is read with the real ps. A descendant that remained at the first check appears running and disappears after the SIGTERM of the cleanup.
  const directory = await mkdtemp(join(tmpdir(), 'test-command-members-'));
  const pidFile = join(directory, 'pid');
  const originalKill = process.kill;
  let descendantPid;
  t.after(async () => {
    process.kill = originalKill;
    if (descendantPid) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(directory, { recursive: true, force: true });
  });
  process.kill = (pid, signal) => {
    if (pid < 0 && signal === 0) {
      const error = new Error('kill EPERM');
      error.code = 'EPERM';
      throw error;
    }
    return originalKill(pid, signal);
  };
  const source = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.exit(0);`;
  const result = await runCommand({ id: 'process-table', command: node, args: ['-e', source], timeoutMs: hangMs, onEvent: () => {} });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  descendantPid = Number(await readFile(pidFile, 'utf8'));
  const verify = result.cleanupObservations.find((item) => item.operation === 'verify');
  assert.ok(verify?.members.some((member) => member.pid === descendantPid && !member.state.startsWith('Z')), JSON.stringify(result.cleanupObservations));
  assertEnded(descendantPid);
});

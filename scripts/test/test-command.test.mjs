import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { untilFolderState } from '@soksak/window-check/folder-wait.mjs';
import { runCommand } from '../test-command.mjs';

const node = process.execPath;
// A descendant of a command under test: the tracked fixture program that writes the file of its argument at SIGTERM.
const DESCENDANT = fileURLToPath(new URL('./fixtures/test-command/descendant.cjs', import.meta.url));
// A command under test: the tracked fixture program that writes `ready` once it handles SIGTERM and `term` at SIGTERM, and then
// exits or stays.
const LEADER = fileURLToPath(new URL('./fixtures/test-command/leader.cjs', import.meta.url));
const task = (source) => [node, ['-e', source]];

// Waits for the file `name` of `folder` and resolves with its text; the wait fails when the command `running` ends first.
function untilFile(folder, name, running) {
  const ended = new AbortController();
  running.then(() => ended.abort(new Error(`the command ended before it wrote ${name}`)));
  const path = join(folder, name);
  return untilFolderState(folder, () => (existsSync(path) ? readFileSync(path, 'utf8') : undefined), { signal: ended.signal });
}
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
  assert.deepEqual(events.at(-1), { type: 'pass', id: 'ordered', elapsedMs: events.at(-1).elapsedMs, exitCode: 0, signal: null, error: null });
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

test('a refused SIGTERM at the limit to a group that holds only zombies still reports timeout', { timeout: 10000 }, async (t) => {
  // Injects the refusal of macOS for a group without a running member at the limit: the SIGTERM ends the leader, and the system answers
  // EPERM because the group then holds only the zombie that the process table shows. The group has nothing to end, so the refusal is no
  // signal failure.
  const originalKill = process.kill;
  const originalExecFileSync = childProcess.execFileSync;
  t.after(() => {
    process.kill = originalKill;
    childProcess.execFileSync = originalExecFileSync;
  });
  let group;
  process.kill = (pid, signal) => {
    if (pid < 0 && signal === 'SIGTERM') {
      group = -pid;
      originalKill(pid, signal);
      const error = new Error('kill EPERM');
      error.code = 'EPERM';
      throw error;
    }
    return originalKill(pid, signal);
  };
  childProcess.execFileSync = (file, args, options) => {
    if (file !== 'ps') return originalExecFileSync(file, args, options);
    return `${group} ${group} Z\n`;
  };
  const [command, args] = task(forever);
  const result = await runCommand({ id: 'refused-kill', command, args, timeoutMs: 50, onEvent: () => {} });
  assert.equal(result.status, 'timeout', JSON.stringify({ error: result.error }));
  assert.equal(result.error, null);
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

test('a cancellation sends SIGTERM to the group and the command ends by it', { timeout: testHangMs }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'test-command-term-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const events = [];
  const running = runCommand({ id: 'term', command: node, args: [LEADER, directory, 'exit'], timeoutMs: hangMs, signal: controller.signal, onEvent: (event) => events.push(event) });
  await untilFile(directory, 'ready', running);
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.equal(existsSync(join(directory, 'term')), true, 'the command received no SIGTERM before its end');
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.kill, null, JSON.stringify(result));
  assert.deepEqual(events.filter((event) => event.type === 'kill'), []);
});

test('a command that ignores SIGTERM gets SIGKILL after the grace, and the result names the members that still ran', { timeout: testHangMs }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'test-command-grace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const events = [];
  const running = runCommand({ id: 'grace', command: node, args: [LEADER, directory, 'stay'], timeoutMs: hangMs, signal: controller.signal, onEvent: (event) => events.push(event) });
  const pid = Number(await untilFile(directory, 'ready', running));
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.equal(existsSync(join(directory, 'term')), true, 'the command received no SIGTERM before its end');
  assert.equal(result.signal, 'SIGKILL', JSON.stringify(result));
  assert.equal(result.kill?.reason, 'grace', JSON.stringify(result));
  assert.deepEqual(result.kill.running.map((member) => member.pid), [pid]);
  const killEvents = events.filter((event) => event.type === 'kill');
  assert.deepEqual(killEvents.map((event) => ({ reason: event.reason, running: event.running })), [result.kill]);
  assertEnded(pid);
});

test('a second cancellation sends SIGKILL without waiting for the grace', { timeout: testHangMs }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'test-command-second-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cancel = new AbortController();
  const kill = new AbortController();
  const running = runCommand({ id: 'second', command: node, args: [LEADER, directory, 'stay'], timeoutMs: hangMs, signal: cancel.signal, kill: kill.signal, onEvent: () => {} });
  const pid = Number(await untilFile(directory, 'ready', running));
  cancel.abort();
  // The second cancellation comes at the record of the SIGTERM, which starts the grace; the reason of the kill tells whether the
  // second cancellation or the grace sent SIGKILL.
  await untilFile(directory, 'term', running);
  kill.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.equal(result.signal, 'SIGKILL', JSON.stringify(result));
  assert.equal(result.kill?.reason, 'second-cancellation', JSON.stringify(result));
  assert.deepEqual(result.kill.running.map((member) => member.pid), [pid]);
  assertEnded(pid);
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
// The program that started the descendant ended without it, so the cleanup at the exit of the leader sends it SIGKILL and names it.
test('ends a descendant that the leader leaves with SIGKILL at the exit of the leader and names it', { timeout: testHangMs }, async (t) => {
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
  const source = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,[${JSON.stringify(DESCENDANT)},${JSON.stringify(markerFile)}],{stdio:['ignore','ignore','ignore','ipc']}); child.on('message',message=>{if(message==='ready'){writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.exit(0);}});`;
  const [command, args] = task(source);
  const result = await runCommand({ id: 'resistant-descendant', command, args, timeoutMs: hangMs, onEvent: () => {} });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  descendantPid = Number(await readFile(pidFile, 'utf8'));
  assert.equal(result.kill?.reason, 'leader-exit', JSON.stringify(result));
  assert.deepEqual(result.kill.running.map((member) => member.pid), [descendantPid]);
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
  // The runner ends its leader when the group signal is refused, so the test ends no process itself.
  const originalKill = process.kill;
  t.after(() => { process.kill = originalKill; });
  process.kill = (pid, signal) => {
    if (pid < 0 && signal !== 0) {
      const error = new Error('blocked process-group signal');
      error.code = 'EPERM';
      throw error;
    }
    return originalKill(pid, signal);
  };
  const [command, args] = task('setInterval(()=>{},1000);');
  const result = await runCommand({ id: 'signal-error', command, args, timeoutMs: 20, onEvent: () => {} });
  assert.equal(result.status, 'fail');
  assert.equal(result.error.code, 'EPERM');
  // Keeps the failed signal and the process group. The next occurrence shows which step's signal it was.
  assert.match(result.error.message, /^SIGTERM to process group \d+: blocked process-group signal; running: pid \d+ /);
});

test('ends its own leader when every process-group signal is refused', { timeout: testHangMs }, async () => {
  // Injects the refusal of every process-group signal, so the runner cannot end the group. The leader is the direct child of the runner, and the
  // result must not return while the leader is still a child of this process. The leader ends itself after 3 s, which bounds the process only
  // when the runner leaves it, so a failing run still exits.
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid < 0 && signal !== 0) {
      const error = new Error('blocked process-group signal');
      error.code = 'EPERM';
      throw error;
    }
    return originalKill(pid, signal);
  };
  // The children of this process by the process table. pgrep exits with 1 when no child matches, and it does not list itself.
  const childrenOfThisProcess = () => {
    try {
      return execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).trim().split('\n');
    } catch (error) {
      if (error.status === 1 && error.stdout === '') return [];
      throw error;
    }
  };
  let result;
  let childrenBefore;
  let childrenAfter;
  try {
    childrenBefore = childrenOfThisProcess();
    const source = 'setTimeout(() => process.exit(0), 3000); setInterval(() => {}, 1000);';
    result = await runCommand({ id: 'leader-kept', command: node, args: ['-e', source], timeoutMs: 20, onEvent: () => {} });
    childrenAfter = childrenOfThisProcess();
  } finally {
    process.kill = originalKill;
  }
  assert.equal(result.status, 'fail', JSON.stringify(result));
  assert.deepEqual(childrenAfter, childrenBefore, `the leader is still a child of this process: ${JSON.stringify(childrenAfter)}`);
});

test('forwards a CLI SIGTERM as a cancellation and a second one as SIGKILL without the grace', { timeout: testHangMs }, async (t) => {
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
  // The pid file is created by writing a temporary file and renaming it. The reader never reads an empty file in the middle of the write.
  // The leader and the descendant both ignore SIGTERM, so only the second SIGTERM to the command or the grace ends them.
  const commandSource = `process.on('SIGTERM',()=>{}); const {spawn}=require('node:child_process'); const {renameSync,writeFileSync}=require('node:fs'); const child=spawn(process.execPath,[${JSON.stringify(DESCENDANT)},${JSON.stringify(markerFile)}],{stdio:['ignore','ignore','ignore','ipc']}); child.on('message',message=>{if(message==='ready'){writeFileSync(${JSON.stringify(pidFile + '.tmp')},String(child.pid)); renameSync(${JSON.stringify(pidFile + '.tmp')},${JSON.stringify(pidFile)});}}); setInterval(()=>{},1000);`;
  // The pid file is read once the watch of the folder is active and again at each change, so its rename is seen at any load.
  // The wait ends by the pid file or by the exit of the command that writes it.
  const cliEnded = new AbortController();
  const ready = untilFolderState(directory, () => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : undefined), { signal: cliEnded.signal });
  cli = spawn(node, [join(process.cwd(), 'scripts/test-command.mjs'), '--id', 'cli-signal', '--timeout-ms', String(hangMs), '--', node, '-e', commandSource], { stdio: ['ignore', 'pipe', 'pipe'] });
  cli.once('exit', (code, signal) => cliEnded.abort(new Error(`the command exited with ${code ?? signal} before ${pidFile} was written`)));
  let stdout = '';
  cli.stdout.on('data', (chunk) => { stdout += chunk; });
  // The rename of the pid file is the readiness event.
  descendantPid = Number(await ready);
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0, `pid file holds ${descendantPid}`);
  const closed = new Promise((resolve) => cli.once('close', (code, signal) => resolve({ code, signal })));
  cli.kill('SIGTERM');
  // The descendant writes its marker at the SIGTERM of the group and stays, as the leader does; the second SIGTERM to the command then sends SIGKILL,
  // and the reason of the kill tells whether the second SIGTERM or the grace sent it.
  const termEnded = new AbortController();
  closed.then(() => termEnded.abort(new Error(`the command ended before ${markerFile} was written`)));
  await untilFolderState(directory, () => (existsSync(markerFile) ? true : undefined), { signal: termEnded.signal });
  cli.kill('SIGTERM');
  const closeResult = await closed;
  assert.equal(closeResult.code, 1);
  assert.match(stdout, /"type":"cancelled"/);
  const kills = stdout.split('\n').filter((line) => line.startsWith('{"type":"kill"')).map((line) => JSON.parse(line));
  assert.deepEqual(kills.map((event) => event.reason), ['second-cancellation'], stdout);
  assert.ok(kills[0].running.some((member) => member.pid === descendantPid), stdout);
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

test('reports a refused group signal of the cleanup while a member of the group runs', { timeout: testHangMs }, async (t) => {
  // Injects a member that this user cannot signal: the SIGTERM of the cleanup is refused with EPERM while the process table shows it
  // running, so the cleanup after the exit of the leader cannot end the group, and the result names the member.
  const originalKill = process.kill;
  const originalExecFileSync = childProcess.execFileSync;
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
    if (pid < 0 && signal === 'SIGTERM') {
      const error = new Error('kill EPERM');
      error.code = 'EPERM';
      throw error;
    }
    if (pid < 0 && signal === 0) return true;
    return originalKill(pid, signal);
  };
  const result = await runCommand({ id: 'refused-cleanup', command: node, args: ['-e', 'process.exit(0)'], timeoutMs: hangMs, onEvent: () => {} });
  assert.equal(result.status, 'fail', JSON.stringify(result));
  assert.equal(result.error.code, 'EPERM');
  assert.match(result.error.message, new RegExp(`^SIGTERM to process group ${group}: kill EPERM; running: pid ${group} S$`));
});

test('ends at its limit with the cause when a process outside its group keeps the output open', { timeout: testHangMs }, async (t) => {
  // The leader starts a process in a session of its own that inherits the output and exits. The end of the group does not end that process,
  // so the output stays open, and the limit of the command, its input here, ends the wait for the close with the cause.
  const directory = await mkdtemp(join(tmpdir(), 'test-command-outside-'));
  const pidFile = join(directory, 'pid');
  let outsidePid;
  t.after(async () => {
    if (outsidePid) {
      try { process.kill(outsidePid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const source = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',detached:true}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.exit(0);`;
  const result = await runCommand({ id: 'outside-output', command: node, args: ['-e', source], timeoutMs: 2000, onEvent: () => {} });
  outsidePid = Number(await readFile(pidFile, 'utf8'));
  assert.equal(result.status, 'fail', JSON.stringify(result));
  assert.equal(result.error.code, 'OUTPUT_HELD_OUTSIDE_GROUP', JSON.stringify(result.error));
  assert.match(result.error.message, /a process outside the group holds it$/);
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
  assert.equal(result.error, null);
  assert.equal(result.cleanupObservations, undefined, 'a refusal of a group without a running member is no error and leaves no error record');
});

test('reads the members of a group from the real process table after a denied probe', { timeout: testHangMs }, async (t) => {
  // Only the check is rejected, and the process table is read with the real ps. A descendant that remained at the first check appears running and disappears after the SIGKILL of the cleanup.
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
  // The cleanup ends the descendant only when the table read after the denied probe shows it running.
  assertEnded(descendantPid);
});

test('keeps a process error and a cleanup error together when both occur', async () => {
  const { combineFailures } = await import('../test-command.mjs');
  const processError = new Error('spawn failed');
  const cleanupError = Object.assign(new Error('SIGTERM to process group 10: kill EPERM; running: pid 10 S'), { code: 'EPERM' });
  const both = combineFailures(processError, cleanupError);
  assert.ok(both instanceof AggregateError, 'the cleanup error replaced the process error');
  assert.deepEqual(both.errors, [processError, cleanupError]);
  assert.equal(combineFailures(processError, null), processError);
  assert.equal(combineFailures(null, cleanupError), cleanupError);
  assert.equal(combineFailures(null, null), null);
});

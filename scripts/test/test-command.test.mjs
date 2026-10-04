import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCommand } from '../test-command.mjs';

const node = process.execPath;
const task = (source) => [node, ['-e', source]];

// 끝난 프로세스는 부모가 거둘 때까지 좀비로 남고, 좀비에 대한 kill(pid, 0) 은 성공한다. 그래서 프로세스 표의 상태로 판정한다.
// 이 파일의 다른 테스트가 바꾸는 childProcess.execFileSync 가 아니라 가져올 때의 함수를 쓴다.
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

test('emits ordered start and terminal events with visible output', { timeout: 2000 }, async () => {
  const events = [];
  const [command, args] = task("console.log('visible-out'); console.error('visible-err')");
  const result = await runCommand({ id: 'ordered', command, args, timeoutMs: 500, onEvent: (event) => events.push(event) });
  assert.equal(result.status, 'pass');
  assert.deepEqual(events.map((event) => event.type), ['start', 'pass']);
  assert.deepEqual(events.at(-1), { type: 'pass', id: 'ordered', elapsedMs: events.at(-1).elapsedMs, exitCode: 0, signal: null, error: null, cleanupObservations: [] });
  assert.match(result.stdout, /visible-out/);
  assert.match(result.stderr, /visible-err/);
  assert.ok(events.every((event) => event.id === 'ordered' && Number.isFinite(event.elapsedMs)));
});

test('preserves UTF-8 stdout and stderr across split byte chunks', { timeout: 2000 }, async () => {
  const source = "const out=Buffer.from('한글\\n'); const err=Buffer.from('오류\\n'); process.stdout.write(out.subarray(0,1)); process.stderr.write(err.subarray(0,1)); setTimeout(() => { process.stdout.write(out.subarray(1)); process.stderr.write(err.subarray(1)); }, 10);";
  const [command, args] = task(source);
  const result = await runCommand({ id: 'utf8-split', command, args, timeoutMs: 500, onEvent: () => {} });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(result.stdout, '한글\n');
  assert.equal(result.stderr, '오류\n');
});

test('emits heartbeat progress while the command runs', { timeout: 2000 }, async () => {
  const events = [];
  const [command, args] = task('setTimeout(() => {}, 130)');
  await runCommand({ id: 'heartbeat', command, args, timeoutMs: 500, heartbeatMs: 30, onEvent: (event) => events.push(event) });
  assert.ok(events.some((event) => event.type === 'progress'));
});

test('reports nonzero exit as fail', { timeout: 2000 }, async () => {
  const [command, args] = task('process.exit(7)');
  const result = await runCommand({ id: 'nonzero', command, args, timeoutMs: 500, onEvent: () => {} });
  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 7);
});

test('reports an absent executable as fail with an error', { timeout: 2000 }, async () => {
  const events = [];
  const result = await runCommand({ id: 'enoent', command: 'definitely-not-a-command', args: [], timeoutMs: 500, onEvent: (event) => events.push(event) });
  assert.equal(result.status, 'fail');
  assert.equal(result.error.code, 'ENOENT');
  assert.equal(events.at(-1).error.code, 'ENOENT');
});

test('a forced kill after the child already ended on SIGTERM still reports timeout', { timeout: 10000 }, async () => {
  // SIGTERM 으로 끝난 자식의 종료를 루프가 아직 처리하지 않은 동안 100 ms 뒤의 SIGKILL 이 실행되게 한다. 부하로 루프가
  // 늦을 때와 같은 순서다. 끝난 자식만 남은 프로세스 그룹에 보낸 신호를 macOS 는 EPERM 으로 거부할 수 있다.
  const [command, args] = task('setTimeout(() => {}, 5000)');
  let held = false;
  const result = await runCommand({
    id: 'late-exit', command, args, timeoutMs: 50, heartbeatMs: 50,
    onEvent: (event) => {
      if (event.type !== 'progress' || held) return;
      held = true;
      const until = performance.now() + 150;
      while (performance.now() < until) { /* 루프를 붙잡는다 */ }
    },
  });
  assert.equal(held, true, 'the progress event did not hold the loop');
  assert.equal(result.status, 'timeout', JSON.stringify({ error: result.error, signal: result.signal }));
});

test('a refused forced kill of a group that ended on SIGTERM still reports timeout', { timeout: 10000 }, async (t) => {
  // SIGTERM 으로 끝난 그룹에 100 ms 뒤 보내는 SIGKILL 을 macOS 가 EPERM 으로 거부한 경우를 주입한다. 그룹이 사라졌는지는
  // 정리 단계가 확인하므로, 거부된 강제 종료만으로 실패하지 않는다.
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
  // 자식은 SIGTERM 을 받고 120 ms 뒤에 끝난다. 그래서 100 ms 뒤의 강제 종료가 먼저 실행되어 주입된 거부를 받는다. 300 ms
  // 한도는 자식이 처리기를 둔 뒤에 SIGTERM 이 가게 한다.
  const [command, args] = task("process.on('SIGTERM', () => setTimeout(() => process.exit(0), 120)); setTimeout(() => {}, 5000)");
  const result = await runCommand({ id: 'refused-kill', command, args, timeoutMs: 300, onEvent: () => {} });
  assert.equal(result.status, 'timeout', JSON.stringify({ error: result.error }));
});

test('times out and reports timeout', { timeout: 2000 }, async () => {
  const events = [];
  const [command, args] = task('setTimeout(() => {}, 1000)');
  const result = await runCommand({ id: 'timeout', command, args, timeoutMs: 50, heartbeatMs: 20, onEvent: (event) => events.push(event) });
  assert.equal(result.status, 'timeout');
  assert.equal(events.at(-1).type, 'timeout');
  assert.equal(events.at(-1).exitCode, null);
  assert.equal(events.at(-1).signal, 'SIGTERM');
  assert.equal(events.at(-1).error, null);
});

test('cancels and reports cancelled', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const events = [];
  const [command, args] = task('setTimeout(() => {}, 1000)');
  const promise = runCommand({ id: 'cancel', command, args, timeoutMs: 500, signal: controller.signal, onEvent: (event) => events.push(event) });
  setTimeout(() => controller.abort(), 30);
  const result = await promise;
  assert.equal(result.status, 'cancelled');
  assert.equal(events.at(-1).type, 'cancelled');
  assert.equal(events.at(-1).error, null);
});

test('cleans descendants after the leader exits', { timeout: 2000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'test-command-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = join(directory, 'pid');
  const source = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},1000)'],{stdio:'ignore'}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.exit(0);`;
  const [command, args] = task(source);
  const result = await runCommand({ id: 'descendant', command, args, timeoutMs: 500, onEvent: () => {} });
  const descendantPid = Number(await readFile(pidFile, 'utf8'));
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assertEnded(descendantPid);
});

test('cleans a descendant that inherits supervisor stdio before close', { timeout: 2000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'test-command-inherit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = join(directory, 'pid');
  const source = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},1000)'],{stdio:'inherit'}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.exit(0);`;
  const [command, args] = task(source);
  const result = await runCommand({ id: 'inherited-stdio', command, args, timeoutMs: 500, onEvent: () => {} });
  const descendantPid = Number(await readFile(pidFile, 'utf8'));
  assert.equal(result.status, 'pass');
  assertEnded(descendantPid);
});

test('escalates cleanup for a descendant that ignores SIGTERM', { timeout: 2000 }, async (t) => {
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
  const descendantSource = `const {writeFileSync}=require('node:fs'); process.on('SIGTERM',()=>writeFileSync(${JSON.stringify(markerFile)},'term')); process.send('ready'); setTimeout(()=>{},1000);`;
  const source = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{stdio:['ignore','ignore','ignore','ipc']}); child.on('message',message=>{if(message==='ready'){writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.exit(0);}});`;
  const [command, args] = task(source);
  const result = await runCommand({ id: 'resistant-descendant', command, args, timeoutMs: 500, onEvent: () => {} });
  descendantPid = Number(await readFile(pidFile, 'utf8'));
  assert.equal(result.status, 'pass');
  assert.equal(await readFile(markerFile, 'utf8'), 'term');
  assertEnded(descendantPid);
});

test('turns an event callback exception into a failure and cleans the child', { timeout: 2000 }, async () => {
  const events = [];
  const [command, args] = task('setTimeout(() => {}, 1000)');
  const result = await runCommand({ id: 'callback-error', command, args, timeoutMs: 500, heartbeatMs: 20, onEvent: (event) => {
    if (event.type === 'progress') throw new Error('event callback failed');
    events.push(event);
  } });
  assert.equal(result.status, 'fail');
  assert.equal(result.error.message, 'event callback failed');
  assert.equal(events.at(-1).type, 'fail');
});

test('reports a terminal observer exception instead of claiming success', { timeout: 2000 }, async () => {
  const [command, args] = task('process.stdout.write(\'output-before-terminal\')');
  const result = await runCommand({ id: 'terminal-callback-error', command, args, timeoutMs: 500, onEvent: (event) => {
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
  const source = `const {writeFileSync}=require('node:fs'); writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setTimeout(()=>{},1000);`;
  const [command, args] = task(source);
  const result = await runCommand({ id: 'signal-error', command, args, timeoutMs: 20, onEvent: () => {} });
  assert.equal(result.status, 'fail');
  assert.equal(result.error.code, 'EPERM');
  // 실패한 신호와 프로세스 그룹을 남긴다. 다음 발생에서 어느 단계의 신호인지 알 수 있다.
  assert.match(result.error.message, /^SIGTERM to process group \d+: blocked process-group signal$/);
});

test('forwards CLI SIGTERM to command cancellation and cleanup', { timeout: 3000 }, async (t) => {
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
  const descendantSource = `const {writeFileSync}=require('node:fs'); process.on('SIGTERM',()=>writeFileSync(${JSON.stringify(markerFile)},'term')); process.send('ready'); setTimeout(()=>{},2000);`;
  // pid 파일은 임시 파일에 쓴 뒤 이름을 바꿔 만든다. 읽는 쪽이 쓰기 도중의 빈 파일을 읽지 않는다.
  const commandSource = `const {spawn}=require('node:child_process'); const {renameSync,writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{stdio:['ignore','ignore','ignore','ipc']}); child.on('message',message=>{if(message==='ready'){writeFileSync(${JSON.stringify(pidFile + '.tmp')},String(child.pid)); renameSync(${JSON.stringify(pidFile + '.tmp')},${JSON.stringify(pidFile)});}}); setTimeout(()=>{},2000);`;
  cli = spawn(node, [join(process.cwd(), 'scripts/test-command.mjs'), '--id', 'cli-signal', '--timeout-ms', '1500', '--', node, '-e', commandSource], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  cli.stdout.on('data', (chunk) => { stdout += chunk; });
  const started = Date.now();
  const readyDeadline = started + 1000;
  let read = null;
  while (Date.now() < readyDeadline) {
    try {
      read = await readFile(pidFile, 'utf8');
      const pid = Number(read);
      if (Number.isInteger(pid) && pid > 0) { descendantPid = pid; break; }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(descendantPid, `command did not report descendant readiness within ${Date.now() - started} ms ` +
    `(pid file ${read === null ? 'absent' : JSON.stringify(read)}; load average ${loadavg().map((value) => value.toFixed(1)).join(' ')})`);
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

test('does not convert denied cleanup verification after SIGKILL into success', { timeout: 3000 }, async (t) => {
  // 확인이 거부되고 프로세스 표가 실행 중인 구성원을 보여 주는 상태를 주입한다. 이 사용자가 신호를 보낼 수 없는 구성원이다.
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
  const result = await runCommand({ id: 'denied-verification', command: node, args: ['-e', 'process.exit(0)'], timeoutMs: 1000, onEvent: () => {} });
  assert.equal(result.status, 'fail', JSON.stringify(result));
  assert.equal(result.error.code, 'EPERM');
  assert.ok(result.cleanupObservations.some((item) => item.operation === 'verify' && item.error.code === 'EPERM' && item.members.some((member) => member.pid === group && member.state === 'S')), JSON.stringify(result.cleanupObservations));
});

test('counts a process group that holds only zombies as gone after a denied probe', { timeout: 3000 }, async (t) => {
  // 측정된 상태를 주입한다. 구성원이 모두 끝났지만 거둬지지 않은 그룹에 macOS 의 kill(-pgid, sig) 는 EPERM 을 돌려주고,
  // 프로세스 표는 그 구성원을 좀비(Z)로 보여 준다.
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
  const result = await runCommand({ id: 'zombie-group', command: node, args: ['-e', 'process.exit(0)'], timeoutMs: 1000, onEvent: () => {} });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.deepEqual(result.cleanupObservations, [{ operation: 'verify', error: { name: 'Error', message: 'kill EPERM', code: 'EPERM' }, members: [{ pid: group + 1, state: 'Z' }] }]);
});

test('reads the members of a group from the real process table after a denied probe', { timeout: 3000 }, async (t) => {
  // 확인만 거부하고 프로세스 표는 실제 ps 로 읽는다. 첫 확인에서 남은 자손은 실행 중으로 보이고, 정리의 SIGTERM 뒤에는 사라진다.
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
  const source = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:'ignore'}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.exit(0);`;
  const result = await runCommand({ id: 'process-table', command: node, args: ['-e', source], timeoutMs: 1000, onEvent: () => {} });
  descendantPid = Number(await readFile(pidFile, 'utf8'));
  assert.equal(result.status, 'pass', JSON.stringify(result));
  const verify = result.cleanupObservations.find((item) => item.operation === 'verify');
  assert.ok(verify?.members.some((member) => member.pid === descendantPid && !member.state.startsWith('Z')), JSON.stringify(result.cleanupObservations));
  assertEnded(descendantPid);
});

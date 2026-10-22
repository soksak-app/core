// Runs a list of tests as separate processes in a bounded pool and reports what runs, for how long and how it ended
// (docs/operations/examples.md#test-runner). Every test has its own limit; no limit is above 10 minutes, and a test that
// needs more is reported before it is allowed.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// The process table reader of the command supervisor: a process group is read from the table, because kill(-pgid, 0) on macOS
// also answers for a group that holds only zombies (test-command.mjs).
import { groupMembers, runningMembers } from './test-command.mjs';

/** The longest limit a test may have. A test that needs more is reported with its reason first. */
export const MAX_TEST_TIMEOUT_MS = 600_000;

const seconds = (ms) => (ms / 1000).toFixed(3);
/** The wall clock in microseconds, the unit of `ts_us` in the event logs, so a test window compares with the records. */
const nowUs = () => Math.round((performance.timeOrigin + performance.now()) * 1000);

function validate(options) {
  if (!options || typeof options !== 'object') throw new TypeError('options is required');
  const { tests, concurrency } = options;
  if (!Array.isArray(tests) || tests.length === 0) throw new TypeError('there are no tests to run');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer');
  if (typeof options.write !== 'function') throw new TypeError('write must be a function');
  const names = new Set();
  for (const item of tests) {
    if (typeof item.name !== 'string' || item.name === '') throw new TypeError('a test needs a name');
    if (names.has(item.name)) throw new TypeError(`the test ${item.name} is listed twice`);
    names.add(item.name);
    if (typeof item.command !== 'string' || !Array.isArray(item.args)) throw new TypeError(`${item.name}: command and args are required`);
    // Each test carries its own limit; the runner applies no run-wide default (AGENTS.md Verification).
    if (item.timeoutMs === undefined) throw new TypeError(`test ${item.name} has no timeoutMs`);
    if (!Number.isInteger(item.timeoutMs) || item.timeoutMs < 1 || item.timeoutMs > MAX_TEST_TIMEOUT_MS) {
      throw new TypeError(`${item.name}: timeoutMs must be an integer from 1 through ${MAX_TEST_TIMEOUT_MS}`);
    }
  }
}

/**
 * The processes of the group of a test that still run, except `leader`, as `pid <n> <command>` names. A test process that ends while a
 * process it started keeps running (an open timer, a listener, a child) leaves that process in the group, so the group names it.
 */
function leftoverNames(pgid, leader) {
  const members = runningMembers(pgid).filter((member) => member.pid !== leader);
  if (members.length === 0) return [];
  const commands = new Map();
  for (const line of execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2]);
  }
  return members.map((member) => `pid ${member.pid} ${commands.get(member.pid) ?? '(ended while it was named)'}`);
}

/** Sends a signal to the process group pgid. The default is the group signal of the system; a test passes its own sender. */
const sendToGroup = (pgid, signal) => process.kill(-pgid, signal);

/**
 * Stops every process of the group of a test with SIGSTOP, so none of them runs while the leftovers are read. The stop comes before the
 * read, because the read takes seconds under load. A group that no longer exists has nothing to stop.
 */
/**
 * Sends a signal to the group pgid. macOS refuses a group signal with EPERM when no member of the group can receive it, which is the case
 * when only zombies remain; such a group has nothing to end, so the refusal is not an error. A refusal while a member runs is an error,
 * and the error names the running members.
 */
function signalGroup(pgid, signal, send) {
  try { send(pgid, signal); } catch (error) {
    if (error.code === 'ESRCH') return;
    if (error.code !== 'EPERM') throw error;
    const running = runningMembers(pgid);
    if (running.length === 0) return;
    error.message = `${signal} to process group ${pgid}: ${error.message}; running: ${running.map((member) => `pid ${member.pid} ${member.state}`).join('; ')}`;
    throw error;
  }
}

export function stopGroup(pgid, send = sendToGroup) {
  signalGroup(pgid, 'SIGSTOP', send);
}

/** Ends every process of the group of a test. A group that no longer exists has nothing to end. */
export function killGroup(pgid, send = sendToGroup) {
  signalGroup(pgid, 'SIGKILL', send);
}

/**
 * Ends the group of a test in the order stop, list, kill: the stop comes first, so no process of the group runs while the process table is
 * read, which takes seconds under load. It returns the leftovers except `leader`.
 */
function endGroup(pgid, leader) {
  stopGroup(pgid);
  const leftovers = leftoverNames(pgid, leader);
  killGroup(pgid);
  return leftovers;
}

/**
 * Runs one test process and resolves with its status, elapsed time and output. The test process runs in a group of its own, so the
 * processes it starts belong to the group. When the test process exits, a process that remains in the group is a leftover: the group is
 * ended and the test fails with the names of the leftovers. At its limit the group is ended, and the timeout names the leftovers
 * other than the test process, which node --test keeps running until its files end.
 */
function runOne(item, limitMs, env, outputPath) {
  return new Promise((resolve) => {
    const started = performance.now();
    const chunks = [];
    const child = spawn(item.command, item.args, {
      cwd: item.cwd, env: { ...process.env, ...env, ...item.env },
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let timedOutElapsedMs = 0;
    let timeoutLeftovers = [];
    let exitLeftovers = [];
    // A failure to end the group is kept and reported in the result of the test.
    let groupError = null;
    // At the limit the group is stopped first, and the elapsed time is taken at that stop, so a slow listing of the leftovers does not
    // move the time of the timeout.
    const timer = setTimeout(() => {
      timedOut = true;
      timedOutElapsedMs = performance.now() - started;
      try { timeoutLeftovers = endGroup(child.pid, child.pid); } catch (error) { groupError = error; }
    }, limitMs);
    child.once('exit', () => {
      if (timedOut) return;
      try { exitLeftovers = endGroup(child.pid, null); } catch (error) { groupError = error; }
    });
    // A file of the run receives the output as it arrives, so a run that stops leaves the output of the test it stopped in.
    const keep = (chunk) => {
      chunks.push(chunk);
      if (outputPath) appendFileSync(outputPath, chunk);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ status: 'fail', elapsedMs: performance.now() - started, output: error.message, detail: `could not start: ${error.message}` });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const elapsedMs = performance.now() - started;
      const output = Buffer.concat(chunks).toString('utf8');
      if (groupError) {
        resolve({ status: 'fail', elapsedMs: timedOut ? timedOutElapsedMs : elapsedMs, output, detail: `could not end the process group: ${groupError.message}` });
      } else if (timedOut) {
        const left = timeoutLeftovers.length > 0 ? `; left running: ${timeoutLeftovers.join('; ')}` : '';
        resolve({ status: 'timeout', elapsedMs: timedOutElapsedMs, output, detail: `exceeded ${seconds(limitMs)}s and was killed${left}` });
      } else if (exitLeftovers.length > 0) resolve({ status: 'fail', elapsedMs, output, detail: `left running after exit: ${exitLeftovers.join('; ')}` });
      else if (code === 0) resolve({ status: 'pass', elapsedMs, output, detail: '' });
      else resolve({ status: 'fail', elapsedMs, output, detail: code === null ? `signal ${signal}` : `exit ${code}` });
    });
  });
}

/**
 * Runs `tests` (`{name, command, args, cwd?, env?, timeoutMs?}`) with at most `concurrency` processes at once. `write(line)`
 * receives one line per event: `RUN`, `PASS`, `FAIL`, `TIME`, a `RUNNING` line every `heartbeatMs` that names the tests in
 * flight with their running time, the `SLOWEST` tests, and the `TOTAL`. Resolves with `{results, slowest}`; a result is
 * `{status, elapsedMs, output}` with the status `pass`, `fail` or `timeout`. `beforeEach(item)`, when given, is awaited before each test
 * starts; the line `WAIT <name>` names the test that waits for it. `run` (`{id, folder}`), when given, passes the identifier and the folder to each
 * test as `SOKSAK_RUN_ID` and the folder as `SOKSAK_RUN_FOLDER`, stores the output of every test in the folder, and keeps `manifest.json` there with each test, its status,
 * its start and its end in microseconds; the manifest is rewritten when a test starts and when it ends.
 */
export async function runTests(options) {
  validate(options);
  const { tests, concurrency, write } = options;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const slowCount = options.slowCount ?? 10;
  const begun = performance.now();
  const running = new Map();
  const results = new Map();
  const queue = [...tests];
  const run = options.run;
  const manifest = run ? { schema: 1, run: run.id, started_us: nowUs(), finished_us: null, tests: [] } : null;
  if (run) mkdirSync(run.folder, { recursive: true });
  const saveManifest = () => {
    const path = join(run.folder, 'manifest.json');
    writeFileSync(`${path}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
  };
  const beat = setInterval(() => {
    if (running.size === 0) return;
    const flight = [...running].map(([name, since]) => `${name} ${seconds(performance.now() - since)}s`).join(', ');
    write(`RUNNING ${running.size} test${running.size === 1 ? '' : 's'}, ${seconds(performance.now() - begun)}s since the start: ${flight}`);
  }, heartbeatMs);
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      // The gate decides when the test may start (for example only while the person is away); the wait is not part of its limit.
      if (options.beforeEach) {
        write(`WAIT ${item.name}`);
        await options.beforeEach(item);
      }
      running.set(item.name, performance.now());
      const limit = item.timeoutMs;
      write(`RUN  ${item.name} (${running.size} running, limit ${seconds(limit)}s)`);
      let entry = null;
      if (run) {
        const output = `${String(manifest.tests.length + 1).padStart(3, '0')}-${item.name.replace(/[^A-Za-z0-9._-]/g, '_')}.log`;
        entry = { name: item.name, status: 'running', started_us: nowUs(), ended_us: null, elapsed_ms: null, detail: '', output };
        manifest.tests.push(entry);
        writeFileSync(join(run.folder, output), '');
        saveManifest();
      }
      const result = await runOne(item, limit, run ? { SOKSAK_RUN_ID: run.id, SOKSAK_RUN_FOLDER: run.folder } : {}, entry && join(run.folder, entry.output));
      running.delete(item.name);
      if (entry) {
        Object.assign(entry, { status: result.status, ended_us: nowUs(), elapsed_ms: Math.round(result.elapsedMs), detail: result.detail });
        saveManifest();
      }
      results.set(item.name, result);
      const label = { pass: 'PASS', fail: 'FAIL', timeout: 'TIME' }[result.status];
      write(`${label} ${item.name} ${seconds(result.elapsedMs)}s${result.detail ? ` ${result.detail}` : ''}`);
      if (result.status !== 'pass') for (const line of result.output.split('\n')) if (line !== '') write(`  ${line}`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, tests.length) }, worker));
  } finally {
    clearInterval(beat);
  }
  if (run) {
    manifest.finished_us = nowUs();
    saveManifest();
  }
  const slowest = [...results].map(([name, result]) => ({ name, elapsedMs: result.elapsedMs }))
    .sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, slowCount);
  write(`SLOWEST ${slowest.map((item) => `${item.name} ${seconds(item.elapsedMs)}s`).join(', ')}`);
  const count = (status) => [...results.values()].filter((result) => result.status === status).length;
  write(`TOTAL ${results.size} tests: ${count('pass')} pass, ${count('fail')} fail, ${count('timeout')} timeout in ${seconds(performance.now() - begun)}s`);
  return { results, slowest };
}

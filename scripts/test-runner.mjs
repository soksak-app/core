// Runs a list of tests as separate processes in a bounded pool and reports what runs, for how long and how it ended
// (docs/operations/examples.md#test-runner). Every test has its own limit; no limit is above 10 minutes, and a test that
// needs more is reported before it is allowed.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The longest limit a test may have. A test that needs more is reported with its reason first. */
export const MAX_TEST_TIMEOUT_MS = 600_000;

const seconds = (ms) => (ms / 1000).toFixed(3);
/** The wall clock in microseconds, the unit of `ts_us` in the event logs, so a test window compares with the records. */
const nowUs = () => Math.round((performance.timeOrigin + performance.now()) * 1000);

function validate(options) {
  if (!options || typeof options !== 'object') throw new TypeError('options is required');
  const { tests, concurrency, defaultTimeoutMs } = options;
  if (!Array.isArray(tests) || tests.length === 0) throw new TypeError('there are no tests to run');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer');
  if (!Number.isInteger(defaultTimeoutMs) || defaultTimeoutMs < 1 || defaultTimeoutMs > MAX_TEST_TIMEOUT_MS) {
    throw new TypeError(`defaultTimeoutMs must be an integer from 1 through ${MAX_TEST_TIMEOUT_MS}`);
  }
  if (typeof options.write !== 'function') throw new TypeError('write must be a function');
  const names = new Set();
  for (const item of tests) {
    if (typeof item.name !== 'string' || item.name === '') throw new TypeError('a test needs a name');
    if (names.has(item.name)) throw new TypeError(`the test ${item.name} is listed twice`);
    names.add(item.name);
    if (typeof item.command !== 'string' || !Array.isArray(item.args)) throw new TypeError(`${item.name}: command and args are required`);
    if (item.timeoutMs !== undefined && (!Number.isInteger(item.timeoutMs) || item.timeoutMs < 1 || item.timeoutMs > MAX_TEST_TIMEOUT_MS)) {
      throw new TypeError(`${item.name}: timeoutMs must be an integer from 1 through ${MAX_TEST_TIMEOUT_MS}`);
    }
  }
}

/** Runs one test process and resolves with its status, elapsed time and output. */
function runOne(item, limitMs, env, outputPath) {
  return new Promise((resolve) => {
    const started = performance.now();
    const chunks = [];
    const child = spawn(item.command, item.args, {
      cwd: item.cwd, env: { ...process.env, ...env, ...item.env },
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }, limitMs);
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
      if (timedOut) resolve({ status: 'timeout', elapsedMs, output, detail: `exceeded ${seconds(limitMs)}s and was killed` });
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
 * starts; the line `WAIT <name>` names the test that waits for it. `run` (`{id, folder}`), when given, passes the identifier to each
 * test as `SOKSAK_RUN_ID`, stores the output of every test in the folder, and keeps `manifest.json` there with each test, its status,
 * its start and its end in microseconds; the manifest is rewritten when a test starts and when it ends.
 */
export async function runTests(options) {
  validate(options);
  const { tests, concurrency, defaultTimeoutMs, write } = options;
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
      write(`RUN  ${item.name} (${running.size} running)`);
      const limit = item.timeoutMs ?? defaultTimeoutMs;
      let entry = null;
      if (run) {
        const output = `${String(manifest.tests.length + 1).padStart(3, '0')}-${item.name.replace(/[^A-Za-z0-9._-]/g, '_')}.log`;
        entry = { name: item.name, status: 'running', started_us: nowUs(), ended_us: null, elapsed_ms: null, detail: '', output };
        manifest.tests.push(entry);
        writeFileSync(join(run.folder, output), '');
        saveManifest();
      }
      const result = await runOne(item, limit, run ? { SOKSAK_RUN_ID: run.id } : {}, entry && join(run.folder, entry.output));
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

// Runs a list of tests as separate processes in a bounded pool and reports what runs, for how long and how it ended
// (docs/operations/examples.md#test-parity). The runner has no limit for a test file: each test of a file carries its own limit
// (node:test `timeout`, or the per-test default that the harness passes to node --test). An item may declare `timeoutMs` for a
// command that has no per-test limit, such as a build; no such limit is above 10 minutes. The exit limit (`exitLimitMs`) bounds only the
// exit of a test file process after its tests ended, when no test runs.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { sampleProcess } from '@soksak/window-check/stall-sample.mjs';
// The process table reader of the command supervisor: a process group is read from the table, because kill(-pgid, 0) on macOS
// also answers for a group that holds only zombies (test-command.mjs).
import { hasEnded, killGroup, processTable, runningMembers, stopGroup } from './test-command.mjs';
import { EVENT_PREFIX } from './test-event-reporter.mjs';
import { createNodeTestEvidence } from './node-test-evidence.mjs';
import { linkerWarnings } from './macos-minimum.mjs';

/** The longest limit a test may have. A test that needs more is reported with its reason first. */
export const MAX_TEST_TIMEOUT_MS = 600_000;

const seconds = (ms) => (ms / 1000).toFixed(3);
/**
 * The time that a test process with `stacksAtLimit` has after its limit to write its stacks and exit, before the runner ends its group.
 * A Go test binary with `-test.timeout` of the limit panics at that limit, writes the stacks of every goroutine and exits with status 2;
 * the write takes milliseconds.
 */
export const STACK_LIMIT_MS = 10_000;
/** The wall clock in microseconds, the unit of `ts_us` in the event logs, so a test window compares with the records. */
const nowUs = () => Math.round((performance.timeOrigin + performance.now()) * 1000);

function validate(options) {
  if (!options || typeof options !== 'object') throw new TypeError('options is required');
  const { tests, concurrency } = options;
  if (!Array.isArray(tests) || tests.length === 0) throw new TypeError('there are no tests to run');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer');
  if (typeof options.write !== 'function') throw new TypeError('write must be a function');
  const names = new Set();
  // The tests that a run counts are the tests that its processes ran, which only a process that reports its test events knows, so a run
  // counts either the tests of every process or none (runTests).
  const reporting = tests[0].eventLimitMs !== undefined;
  for (const item of tests) {
    if (typeof item.name !== 'string' || item.name === '') throw new TypeError('a test needs a name');
    if (names.has(item.name)) throw new TypeError(`the test ${item.name} is listed twice`);
    names.add(item.name);
    if (typeof item.command !== 'string' || !Array.isArray(item.args)) throw new TypeError(`${item.name}: command and args are required`);
    if (item.nodeTestFile !== undefined && (typeof item.nodeTestFile !== 'string' || item.nodeTestFile.length === 0)) {
      throw new TypeError(`${item.name}: nodeTestFile must name the file whose test evidence is required`);
    }
    // The runner applies no run-wide or file-wide limit (AGENTS.md Verification). A declared limit is checked; an absent one means
    // that the process has no limit of the runner.
    if (item.timeoutMs !== undefined && (!Number.isInteger(item.timeoutMs) || item.timeoutMs < 1 || item.timeoutMs > MAX_TEST_TIMEOUT_MS)) {
      throw new TypeError(`${item.name}: timeoutMs must be an integer from 1 through ${MAX_TEST_TIMEOUT_MS}`);
    }
    // A process that writes its stacks and exits at its own limit (runOne), such as a Go test binary with -test.timeout of the limit.
    if (item.stacksAtLimit !== undefined && (item.stacksAtLimit !== true || item.timeoutMs === undefined)) {
      throw new TypeError(`${item.name}: stacksAtLimit must be true and needs timeoutMs`);
    }
    // The event watchdog of a process that reports its test events (runOne). A process without the field has no watchdog.
    if (item.eventLimitMs !== undefined && (!Number.isInteger(item.eventLimitMs) || item.eventLimitMs < 1 || item.eventLimitMs > MAX_TEST_TIMEOUT_MS)) {
      throw new TypeError(`${item.name}: eventLimitMs must be an integer from 1 through ${MAX_TEST_TIMEOUT_MS}`);
    }
    if ((item.eventLimitMs !== undefined) !== reporting) {
      throw new TypeError(`${item.name}: every test of a run reports its test events (eventLimitMs) or none does`);
    }
    // The exit limit of a process after its tests ended (runOne). The samples that it takes are kept in the folder of the run.
    if (item.exitLimitMs !== undefined) {
      if (!Number.isInteger(item.exitLimitMs) || item.exitLimitMs < 1 || item.exitLimitMs > MAX_TEST_TIMEOUT_MS) {
        throw new TypeError(`${item.name}: exitLimitMs must be an integer from 1 through ${MAX_TEST_TIMEOUT_MS}`);
      }
      if (!options.run) throw new TypeError(`${item.name}: exitLimitMs needs the folder of a run, which keeps the samples of the process`);
    }
  }
}

/**
 * The processes of the group of a test that still run, except `leader`, as `pid <n> <command>` names. A test process that ends while a
 * process it started keeps running (an open timer, a listener, a child) leaves that process in the group, so the group names it.
 */
function leftoverNames(pgid, leader, escaped, table) {
  const inGroup = runningMembers(pgid, table.filter((row) => row.pgid === pgid));
  const members = [...inGroup.filter((member) => member.pid !== leader), ...escaped.map((pid) => ({ pid }))];
  if (members.length === 0) return [];
  // Only the members are read: the commands of every process of the system can exceed the output buffer of execFileSync. ps exits
  // with 1 when no listed process remains, which leaves the members unnamed.
  const listed = spawnSync('ps', ['-o', 'pid=,command=', '-p', members.map((member) => member.pid).join(',')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (listed.error) throw new Error(`ps of the members of process group ${pgid}: ${listed.error.message}`);
  if (listed.status !== 0 && !(listed.status === 1 && listed.stdout === '')) {
    throw new Error(`ps of the members of process group ${pgid} exited with ${listed.status}: ${listed.stderr.trim()}`);
  }
  const commands = new Map();
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2]);
  }
  return members.map((member) => `pid ${member.pid} ${commands.get(member.pid) ?? '(ended while it was named)'}`);
}

/**
 * Stops the running descendants of the members of group pgid that run in another group, and adds each to `stopped`. A test process can
 * start a process in a group of its own, as `runTests` does for each test, and ending the group alone leaves that process with parent 1.
 * A descendant is found through its parent, so the members are stopped first and the descendants are stopped before the parents end;
 * the table is read again until a read finds no running descendant that is not stopped, so a descendant cannot start another unseen.
 * It returns the last table, which lists the members of the group for their names.
 */
function stopEscapedDescendants(pgid, stopped) {
  for (;;) {
    const table = processTable();
    const tree = new Set(table.filter((row) => row.pgid === pgid).map((row) => row.pid));
    const fresh = [];
    for (let grew = true; grew;) {
      grew = false;
      for (const row of table) {
        if (tree.has(row.pid) || !tree.has(row.ppid)) continue;
        tree.add(row.pid);
        grew = true;
        if (row.pgid !== pgid && !hasEnded(row.state) && !stopped.has(row.pid)) fresh.push(row.pid);
      }
    }
    if (fresh.length === 0) return table;
    for (const pid of fresh) {
      try { process.kill(pid, 'SIGSTOP'); } catch (error) { if (error.code !== 'ESRCH') throw error; continue; }
      stopped.add(pid);
    }
  }
}

/**
 * Ends the group of a test in the order stop, list, kill: the stop comes first, so no process of the group runs while the process table is
 * read, which takes seconds under load. The descendants that run in another group are stopped, named and ended with the group. It returns
 * the leftovers except `leader`. The kill follows the list even when the list fails, so a failed list never leaves the group stopped; the
 * error of the list is thrown after the kill, and a failed kill names it too. A group without a process has nothing to end, and its end
 * reads no process table: a test process that exits and leaves nothing is the common end of a test. macOS refuses the check with EPERM
 * for a group that holds only zombies, which the table then shows as ended.
 */
function endGroup(pgid, leader) {
  try { process.kill(-pgid, 0); } catch (error) {
    if (error.code === 'ESRCH') return [];
    if (error.code !== 'EPERM') throw error;
  }
  stopGroup(pgid);
  let leftovers;
  let listError = null;
  const escaped = new Set();
  try {
    const table = stopEscapedDescendants(pgid, escaped);
    leftovers = leftoverNames(pgid, leader, [...escaped], table);
  } catch (error) { listError = error; }
  try {
    killGroup(pgid);
    for (const pid of escaped) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  } catch (error) {
    if (listError) error.message = `${error.message}; the list before the kill failed: ${listError.message}`;
    throw error;
  }
  if (listError) throw listError;
  return leftovers;
}

/**
 * Runs one test process and resolves with its status, elapsed time and output. The test process runs in a group of its own, so the
 * processes it starts belong to the group. When the test process exits, a process that remains in the group is a leftover: the group is
 * ended and the test fails with the names of the leftovers. When the item declares a limit, the group is ended at that limit, and the
 * timeout names the leftovers other than the test process.
 */
function runOne(item, limitMs, env, outputPath) {
  return new Promise((resolve) => {
    const started = performance.now();
    const chunks = [];
    const child = spawn(item.command, item.args, {
      cwd: item.cwd, env: { ...process.env, ...env, ...item.env },
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The limit that ended the group, with the time of the stop and the reason; the leftovers are named when the group is ended.
    let limit = null;
    let exitLeftovers = [];
    // A failure to end the group is kept and reported in the result of the test.
    let groupError = null;
    // The event watchdog of a process with `eventLimitMs` (AGENTS.md Verification: a test file that reports its events). Every test
    // event of the process re-arms it, and the start of the process arms it, so a file whose events stop for the limit holds a test that
    // blocks the event loop, which the test's own limit cannot end. The last event names the test that the stop follows.
    let lastEvent = 'none';
    let eventError = null;
    let watchdog = null;
    // The sampling and the end of a process that did not exit after its tests ended; the result waits for it.
    let ending = null;
    const endAtLimit = (reason) => {
      if (limit !== null) return;
      limit = { elapsedMs: performance.now() - started, reason, leftovers: [] };
      clearTimeout(watchdog);
      try { limit.leftovers = endGroup(child.pid, child.pid); } catch (error) { groupError = error; }
    };
    const arm = () => {
      if (item.eventLimitMs === undefined) return;
      clearTimeout(watchdog);
      watchdog = setTimeout(() => endAtLimit(`no test event for ${item.eventLimitMs} ms, the largest limit of a test; last event: ${lastEvent}`), item.eventLimitMs);
    };
    // The exit limit of a process with `exitLimitMs`: `test:summary` is the last event of the tests of a file, so the process only exits
    // after it, and no test limit applies to that exit. A process that does not exit within the limit waits in its shutdown, which a
    // deadlock of the runtime at exit can cause; its stacks are kept with sample before its group is ended, so the failure names
    // where it waits. An event after the summary (the events of the test runner process after its file process exited) re-arms the
    // event watchdog.
    const endAfterTests = () => {
      if (limit !== null) return;
      limit = { elapsedMs: performance.now() - started, status: 'fail', reason: '', leftovers: [] };
      ending = (async () => {
        const samples = [];
        const errors = [];
        try {
          for (const member of runningMembers(child.pid)) {
            const file = join(dirname(outputPath), `${basename(outputPath, '.log')}.exit-${member.pid}.sample.txt`);
            try { samples.push(await sampleProcess(member.pid, file)); } catch (error) { errors.push(error.message); }
          }
        } catch (error) { errors.push(`the process group ${child.pid} could not be read: ${error.message}`); }
        const failed = errors.length > 0 ? `; sample errors: ${errors.join('; ')}` : '';
        limit.reason = `the file process did not exit within ${seconds(item.exitLimitMs)}s after its tests ended; last event: ${lastEvent}; samples: ${samples.length > 0 ? samples.join(', ') : 'none'}${failed}`;
        try { limit.leftovers = endGroup(child.pid, child.pid); } catch (error) { groupError = error; }
      })();
    };
    const armExit = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(endAfterTests, item.exitLimitMs);
    };
    // At the limit the group is stopped first, and the elapsed time is taken at that stop, so a slow listing of the leftovers does not
    // move the time of the timeout.
    // A process without a declared limit has no timer; its tests end by their own limits.
    // A process with `stacksAtLimit` ends itself at its own limit with its stacks, and its exit after the limit is its timeout (the
    // exit handler). The runner sends it no signal: a SIGQUIT that arrives while a Go test binary panics at its -test.timeout ends the
    // Go runtime with `fatal error: semasleep on Darwin signal stack` and no stacks. Its timer only ends a process that did not end
    // itself within STACK_LIMIT_MS after the limit.
    const timer = limitMs === undefined ? null : item.stacksAtLimit
      ? setTimeout(() => endAtLimit(`exceeded ${seconds(limitMs)}s and did not end itself with its stacks within ${seconds(STACK_LIMIT_MS)}s; it was killed`), limitMs + STACK_LIMIT_MS)
      : setTimeout(() => endAtLimit(`exceeded ${seconds(limitMs)}s and was killed`), limitMs);
    arm();
    // The tests of a process that reports its test events, by `nesting` and name: `queued` holds the tests enqueued and not yet
    // dequeued, `running` the tests dequeued and not yet complete, each with its count. node --test reports no result, error or
    // cancellation for a test whose file process ended while it ran, so a test left in `running` when the process ends has no result.
    // `fileExit` is the exit code and signal that node --test sets on the result of a file whose process failed.
    const queued = new Map();
    const running = new Map();
    let fileExit = null;
    // The tests that the process ran: the summary of each file counts its started tests, of which the skipped ones did not run.
    let ran = 0;
    // The evidence of a node test file (`nodeTestFile`): its own summary and the skipped or todo tests that the process completed.
    const testEvidence = item.nodeTestFile === undefined ? null : createNodeTestEvidence([item.nodeTestFile]);
    const count = (tests, key, step) => {
      const left = (tests.get(key) ?? 0) + step;
      if (left === 0) tests.delete(key);
      else tests.set(key, left);
    };
    const track = (event) => {
      testEvidence?.track(event);
      const key = `${event.nesting}\0${event.name}`;
      if (event.type === 'test:enqueue') count(queued, key, 1);
      else if (event.type === 'test:dequeue') {
        if (queued.has(key)) count(queued, key, -1);
        count(running, key, 1);
      } else if (event.type === 'test:complete') {
        if (running.has(key)) count(running, key, -1);
        if (Object.hasOwn(event, 'exitCode')) fileExit = { exitCode: event.exitCode, signal: event.signal };
      } else if (event.type === 'test:summary' && Object.hasOwn(event, 'file')) {
        const { tests, skipped } = event.counts ?? {};
        if (!Number.isInteger(tests) || !Number.isInteger(skipped)) throw new Error(`the summary of ${event.file} has no counts of tests and skipped tests`);
        ran += tests - skipped;
      }
    };
    // The standard error carries the event lines of the reporter and the TAP form of the tests. A line is read when it is complete.
    const decoder = new StringDecoder('utf8');
    let pending = '';
    child.stderr.on('data', (chunk) => {
      pending += decoder.write(chunk);
      for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.startsWith(EVENT_PREFIX)) continue;
        try {
          const event = JSON.parse(line.slice(EVENT_PREFIX.length));
          lastEvent = event.name === '' ? event.type : `${event.type} ${event.name}`;
          track(event);
          if (event.type === 'test:summary' && item.exitLimitMs !== undefined) armExit();
          else arm();
        } catch (error) {
          // The line is kept in the output of the file, and the file fails with the reason; the reporter writes only well-formed lines.
          eventError ??= new Error(`the test event line ${JSON.stringify(line)} cannot be read: ${error.message}`);
        }
      }
    });
    child.once('exit', () => {
      clearTimeout(watchdog);
      // A process with `stacksAtLimit` that exits after its limit ended itself at that limit, whose clock starts after the runner's; the
      // processes that remain in its group are ended now.
      if (limit === null && item.stacksAtLimit && performance.now() - started >= limitMs) {
        clearTimeout(timer);
        endAtLimit(`exceeded ${seconds(limitMs)}s and ended itself with its stacks`);
      }
      if (limit !== null) return;
      try { exitLeftovers = endGroup(child.pid, null); } catch (error) { groupError = error; }
    });
    // A file of the run receives the output as it arrives, so a run that stops leaves the output of the test it stopped in.
    const keep = (chunk) => {
      chunks.push(chunk);
      if (outputPath) appendFileSync(outputPath, chunk);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    // The result of a process that reports its test events carries the tests that it ran (`tests`), which the summaries of its files count;
    // a file that ended before its summary counts none.
    const reporting = item.eventLimitMs !== undefined;
    const finish = (result) => resolve(reporting ? { ...result, tests: ran } : result);
    child.once('error', (error) => {
      clearTimeout(timer);
      clearTimeout(watchdog);
      finish({ status: 'fail', elapsedMs: performance.now() - started, output: error.message, detail: `could not start: ${error.message}` });
    });
    child.once('close', async (code, signal) => {
      clearTimeout(timer);
      clearTimeout(watchdog);
      await ending;
      const elapsedMs = performance.now() - started;
      // The event lines are the reporter's record for the runner, so they are not part of the output of the test.
      const output = Buffer.concat(chunks).toString('utf8').split('\n').filter((line) => !line.startsWith(EVENT_PREFIX)).join('\n');
      const evidenceErrors = testEvidence?.result().errors ?? [];
      const linkerFailures = linkerWarnings(output).failures;
      if (groupError) {
        finish({ status: 'fail', elapsedMs: limit ? limit.elapsedMs : elapsedMs, output, detail: `could not end the process group: ${groupError.message}` });
      } else if (limit !== null) {
        const left = limit.leftovers.length > 0 ? `; left running: ${limit.leftovers.join('; ')}` : '';
        finish({ status: limit.status ?? 'timeout', elapsedMs: limit.elapsedMs, output, detail: `${limit.reason}${left}` });
      } else if (eventError !== null) finish({ status: 'fail', elapsedMs, output, detail: eventError.message });
      else if (running.size > 0) {
        const names = (tests) => [...tests.keys()].map((key) => key.slice(key.indexOf('\0') + 1)).join(', ');
        const end = fileExit === null ? (code === null ? `signal ${signal}` : `exit ${code}`)
          : (fileExit.signal === null ? `exit ${fileExit.exitCode}` : `signal ${fileExit.signal}`);
        const left = exitLeftovers.length > 0 ? `; left running after exit: ${exitLeftovers.join('; ')}` : '';
        const waiting = queued.size > 0 ? `; queued without a start: ${names(queued)}` : '';
        finish({ status: 'fail', elapsedMs, output, detail: `the test process ended by ${end} while a test ran; started without a result: ${names(running)}${waiting}${left}` });
      } else if (exitLeftovers.length > 0) finish({ status: 'fail', elapsedMs, output, detail: `left running after exit: ${exitLeftovers.join('; ')}` });
      // A node test file passes only on its own successful summary with at least one passed test and no skipped, todo, failed or
      // cancelled test (node-test-evidence.mjs): a skipped or todo test is a test that did not run.
      else if (code === 0 && evidenceErrors.length > 0) finish({ status: 'fail', elapsedMs, output, detail: evidenceErrors.join('; ') });
      // A build or test whose output holds a linker warning of an object built for a newer macOS version than the link compiled or linked
      // for another version than the declared minimum (macos-minimum.mjs).
      else if (code === 0 && linkerFailures.length > 0) finish({ status: 'fail', elapsedMs, output, detail: linkerFailures.join('; ') });
      // A process that reports its test events and ran no test passes, and its detail says so.
      else if (code === 0) finish({ status: 'pass', elapsedMs, output, detail: reporting && ran === 0 ? 'no test ran' : '' });
      else finish({ status: 'fail', elapsedMs, output, detail: code === null ? `signal ${signal}` : `exit ${code}` });
    });
  });
}

/**
 * Runs `tests` (`{name, command, args, cwd?, env?, timeoutMs?, stacksAtLimit?, eventLimitMs?, exitLimitMs?}`) with at most `concurrency`
 * processes at once. `stacksAtLimit` declares a process that writes its stacks and exits at its own limit of `timeoutMs`; its exit
 * after that limit is its timeout, and its group is ended at that exit or STACK_LIMIT_MS after the limit.
 * `eventLimitMs` is the event watchdog of a process that reports its test events (scripts/test-event-reporter.mjs), and `exitLimitMs`
 * the limit of its exit after its `test:summary` event, which needs `run`. `nodeTestFile`, when given, requires that file's own
 * successful, nonempty test summary and refuses skipped or todo cases; command-only items do not carry it. `write(line)`
 * receives one line per event: `RUN`, `PASS`, `FAIL`, `TIME`, a `RUNNING` line every `heartbeatMs` that names the tests in
 * flight with their running time, the `SLOWEST` tests, and the `TOTAL`. Resolves with `{results, slowest, passed}`; a result is
 * `{status, elapsedMs, output, detail}` with the status `pass`, `fail` or `timeout`. The processes of a run either all report their test
 * events or none does. A result of a process that reports them also has `tests`, the tests that its files ran, its `PASS` line says
 * `no test ran` when it ran none, and the `TOTAL` counts the tests that ran in the files. `passed` is true when every process passed and,
 * in a run whose processes report their test events, a test ran; otherwise the line `FAIL no test ran in the <n> files of the run` says so. `beforeEach(item)`, when given, is awaited before each test
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
      write(`RUN  ${item.name} (${running.size} running, ${limit === undefined ? 'no runner limit' : `limit ${seconds(limit)}s`})`);
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
  const statuses = `${count('pass')} pass, ${count('fail')} fail, ${count('timeout')} timeout in ${seconds(performance.now() - begun)}s`;
  let passed = count('pass') === results.size;
  if (tests[0].eventLimitMs === undefined) write(`TOTAL ${results.size} tests: ${statuses}`);
  else {
    // The processes of the run report their test events, so each is a file whose tests the total counts.
    const plural = (number, noun) => `${number} ${noun}${number === 1 ? '' : 's'}`;
    const ran = [...results.values()].reduce((sum, result) => sum + result.tests, 0);
    write(`TOTAL ${plural(ran, 'test')} ran in ${plural(results.size, 'file')}: ${statuses}`);
    if (ran === 0) {
      write(`FAIL no test ran in the ${plural(results.size, 'file')} of the run`);
      passed = false;
    }
  }
  return { results, slowest, passed };
}

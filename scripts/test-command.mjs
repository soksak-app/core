import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { groupRuns, named, runningMembers, terminateGroup } from '@soksak/window-check/process-group.mjs';

const supportedPlatforms = new Set(['aix', 'darwin', 'freebsd', 'linux', 'openbsd']);

function validate(options) {
  if (!supportedPlatforms.has(process.platform)) {
    const error = new Error(`command supervision is not supported on ${process.platform}`);
    error.code = 'UNSUPPORTED_PLATFORM';
    throw error;
  }
  if (!options || typeof options !== 'object') throw new TypeError('options is required');
  if (typeof options.id !== 'string' || options.id.length === 0) throw new TypeError('id must be a non-empty string');
  if (typeof options.command !== 'string' || options.command.length === 0) throw new TypeError('command must be a non-empty string');
  if (!Array.isArray(options.args) || options.args.some((arg) => typeof arg !== 'string')) throw new TypeError('args must be an array of strings');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 600000) throw new TypeError('timeoutMs must be an integer from 1 through 600000');
  if (options.heartbeatMs !== undefined && (!Number.isInteger(options.heartbeatMs) || options.heartbeatMs <= 0 || options.heartbeatMs > 5000)) throw new TypeError('heartbeatMs must be an integer from 1 through 5000');
  if (options.cwd !== undefined && typeof options.cwd !== 'string') throw new TypeError('cwd must be a string');
  if (options.onEvent !== undefined && typeof options.onEvent !== 'function') throw new TypeError('onEvent must be a function');
  for (const name of ['signal', 'kill']) {
    const value = options[name];
    if (value !== undefined && (typeof value?.addEventListener !== 'function' || typeof value?.removeEventListener !== 'function' || typeof value.aborted !== 'boolean')) throw new TypeError(`${name} must be an AbortSignal`);
  }
}

function errorData(error) {
  return {
    name: error.name, message: error.message, ...(error.code ? { code: error.code } : {}), ...(error.path ? { path: error.path } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.map(errorData) } : {}),
  };
}

// A command that fails and whose cleanup also fails reports both errors, so neither message is dropped.
export function combineFailures(processError, cleanupError) {
  if (processError && cleanupError) return new AggregateError([processError, cleanupError], 'the command failed and its cleanup failed');
  return processError ?? cleanupError ?? null;
}

/**
 * Waits until the group pid of a supervised command runs nothing, after terminateGroup ended it at the exit of its leader. No event reports
 * the end of a process that is not a child of this process, so the wait reads the group at each 10 ms step until the system has ended
 * every member; the wait has no limit of its own, because SIGKILL, which no process can catch or ignore, has reached each member.
 */
async function untilGroupEnds(pid) {
  while (groupRuns(pid)) await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * Runs a command in a process group of its own. At its limit or at the abort of `signal` the group gets SIGTERM, and SIGKILL when it
 * still runs after the grace of terminateGroup; the abort of `kill`, a second cancellation, sends SIGKILL at once. The members that
 * run when the leader exits get SIGKILL. Each SIGKILL is a `kill` event, and the first is the `kill` field of the result, with its
 * reason (`grace`, `second-cancellation` or `leader-exit`) and the members that still ran.
 */
export function runCommand(options) {
  validate(options);
  const { id, command, args, cwd, timeoutMs, signal, kill, onEvent } = options;
  const heartbeatMs = options.heartbeatMs ?? 5000;
  const emit = onEvent ?? ((event) => process.stdout.write(`${JSON.stringify(event)}\n`));
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  let callbackError;
  let child;
  let terminate;
  const send = (type, fields = {}, terminal = false) => {
    try {
      emit({ type, id, elapsedMs: elapsed(), ...fields });
    } catch (error) {
      if (terminal) {
        process.stderr.write(`command event observer failed: ${error.message}\n`);
        return error;
      }
      callbackError = error;
      if (terminate) terminate('cancelled');
      else throw error;
    }
  };
  send('start');

  return new Promise((resolve) => {
    let timer;
    let heartbeat;
    let finishing = false;
    let closeSeen = false;
    let leaderEnding = false;
    let exited = false;
    let requestedStatus;
    let ending;
    let cleanupPromise;
    let leaderExit;
    let killed = null;
    let exitCode;
    let exitSignal;
    const stdoutChunks = [];
    const stderrChunks = [];

    // One ending per command: the SIGTERM of a limit or a cancellation, or at the exit of the leader the end of the members it left.
    // A refused SIGKILL at the grace while the leader runs is a refused group signal; after the exit of the leader the cleanup reports it.
    const beginEnding = () => {
      if (ending) return ending;
      ending = terminateGroup(child.pid, { exited: leaderExit, report: (record) => {
        killed ??= record;
        send('kill', record);
      } });
      ending.ended.catch((error) => { if (!exited) reportSignalError(error); });
      return ending;
    };
    const beginCleanup = () => {
      if (!child?.pid) return Promise.resolve();
      if (!cleanupPromise) {
        try {
          const { ended } = beginEnding();
          cleanupPromise = ended.then(() => untilGroupEnds(child.pid));
        } catch (error) {
          cleanupPromise = Promise.reject(error);
        }
      }
      return cleanupPromise;
    };
    const finish = async (finishedExitCode, finishedSignal, processError, skipCleanup = false) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      let cleanupError = null;
      if (!skipCleanup) {
        try {
          await beginCleanup();
        } catch (error) {
          cleanupError = error;
        }
      }
      // A cancellation during the end of the group still sends SIGKILL at once, so the listeners stay until the group has ended.
      if (signal) signal.removeEventListener('abort', cancel);
      if (kill) kill.removeEventListener('abort', cancelAgain);
      const error = combineFailures(processError, cleanupError) ?? callbackError;
      const status = error ? 'fail' : (requestedStatus ?? (finishedExitCode !== 0 ? 'fail' : 'pass'));
      const result = { id, status, exitCode: finishedExitCode ?? null, signal: finishedSignal ?? null, kill: killed, elapsedMs: elapsed(), stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'), error: error ? errorData(error) : null };
      const observerError = send(status, { exitCode: result.exitCode, signal: result.signal, error: result.error }, true);
      if (observerError) {
        result.status = 'fail';
        result.error = errorData(observerError);
      }
      resolve(result);
    };
    // A refused group signal leaves the group unended, but the leader is a child of this process. The runner ends the leader by its pid and
    // finishes at its close, so the result does not return while the leader is still a child handle of this process. The group is not verified
    // here, because a cleanup of a group whose signal was refused would repeat the refused signal.
    const reportSignalError = (error) => {
      callbackError = callbackError ?? error;
      process.stderr.write(`command process-group signal failed: ${error.message}\n`);
      if (finishing || leaderEnding) return;
      leaderEnding = true;
      child.stdout.destroy();
      child.stderr.destroy();
      if (closeSeen) finish(exitCode, exitSignal, error, true);
      else child.once('close', () => finish(exitCode, exitSignal, error, true));
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    // A second cancellation is the event that the first one did not end the command, so it sends SIGKILL without the grace. A
    // cancellation that comes while the members that the leader left end after their SIGTERM is such an event too.
    const cancelAgain = () => {
      requestedStatus ??= 'cancelled';
      if (!child?.pid) return;
      try {
        beginEnding().kill('second-cancellation');
      } catch (error) {
        reportSignalError(error);
      }
    };
    const cancel = () => {
      if (requestedStatus || finishing) cancelAgain();
      else terminate('cancelled');
    };
    terminate = (status) => {
      if (finishing || requestedStatus) return;
      requestedStatus = status;
      if (!child?.pid) return;
      if (exited) {
        // The output stays open at the limit after the exit of the leader: the members that the leader left still end within the grace,
        // or a process outside the group holds the output. The limit ends the wait for the close, the result names the cause, and it
        // returns after the end of the group.
        child.stdout.destroy();
        child.stderr.destroy();
        const running = groupRuns(child.pid) ? `; the group still runs: ${named(runningMembers(child.pid))}` : '; a process outside the group holds it';
        const error = new Error(`the output of the command stayed open until its limit after its leader exited${running}`);
        error.code = 'OUTPUT_HELD_OUTSIDE_GROUP';
        finish(exitCode, exitSignal, error);
        return;
      }
      try {
        beginEnding();
      } catch (error) {
        reportSignalError(error);
      }
    };

    if (signal?.aborted || kill?.aborted) {
      requestedStatus = 'cancelled';
      finish(null, null);
      return;
    }

    try {
      child = spawn(command, args, { cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish(null, null, error);
      return;
    }
    child.stdout.on('data', (chunk) => { stdoutChunks.push(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderrChunks.push(chunk); process.stderr.write(chunk); });
    child.once('error', (error) => finish(null, null, error));
    // The exit event of the leader is the event of the stop that terminateGroup waits for; its listener runs before the handler below.
    leaderExit = new Promise((resolve) => child.once('exit', resolve));
    child.once('exit', (leaderExitCode, leaderSignal) => {
      exitCode = leaderExitCode;
      exitSignal = leaderSignal;
      exited = true;
      // The end of the group closes every write end of the output that a member holds, and the close of the output finishes the command.
      // The limit stays armed until that close, so an output that a process outside the group keeps open ends at the limit.
      beginCleanup().catch((error) => {
        if (!closeSeen && !finishing) {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(exitCode, exitSignal, error, true);
        }
      });
    });
    child.once('close', (closedExitCode, closedSignal) => {
      closeSeen = true;
      if (!leaderEnding) finish(closedExitCode, closedSignal);
    });
    timer = setTimeout(() => terminate('timeout'), timeoutMs);
    heartbeat = setInterval(() => { if (!finishing) send('progress'); }, heartbeatMs);
    signal?.addEventListener('abort', cancel, { once: true });
    kill?.addEventListener('abort', cancelAgain, { once: true });
  });
}

function parseCli(argv) {
  let id;
  let timeoutMs;
  let cwd;
  let index = 0;
  while (index < argv.length && argv[index] !== '--') {
    const option = argv[index++];
    if (option === '--id') id = argv[index++];
    else if (option === '--timeout-ms') timeoutMs = Number(argv[index++]);
    else if (option === '--cwd') cwd = argv[index++];
    else throw new Error(`unknown option: ${option}`);
  }
  if (argv[index] !== '--' || !argv[index + 1]) throw new Error('CLI requires --id, --timeout-ms, and -- executable args');
  if (id === undefined || timeoutMs === undefined) throw new Error('CLI requires --id and --timeout-ms');
  return { id, timeoutMs, cwd, command: argv[index + 1], args: argv.slice(index + 2) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // The first SIGINT or SIGTERM cancels the command, and the next one is the second cancellation, which sends SIGKILL at once.
  const controller = new AbortController();
  const killController = new AbortController();
  const cancel = () => (controller.signal.aborted ? killController.abort() : controller.abort());
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const result = await runCommand({ ...parseCli(process.argv.slice(2)), signal: controller.signal, kill: killController.signal });
    process.exitCode = result.status === 'pass' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

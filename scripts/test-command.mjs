import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { groupRuns, killGroup, named, runningMembers } from '@soksak/window-check/process-group.mjs';

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
  if (options.signal !== undefined && (typeof options.signal?.addEventListener !== 'function' || typeof options.signal?.removeEventListener !== 'function' || typeof options.signal.aborted !== 'boolean')) throw new TypeError('signal must be an AbortSignal');
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
 * Ends the group pid of a supervised command after its leader ended, at its limit or at its cancellation: SIGKILL to the group, which no
 * process can catch or ignore, and then a wait until the group runs nothing. No event reports the end of a process that is not a child of
 * this process, so the wait reads the group at each 10 ms step until the system has ended every member; the wait has no limit of its own.
 */
async function cleanupGroup(pid) {
  if (!groupRuns(pid)) return;
  killGroup(pid);
  while (groupRuns(pid)) await new Promise((resolve) => setTimeout(resolve, 10));
}

export function runCommand(options) {
  validate(options);
  const { id, command, args, cwd, timeoutMs, signal, onEvent } = options;
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
    let cleanupPromise;
    let exitCode;
    let exitSignal;
    const stdoutChunks = [];
    const stderrChunks = [];

    const beginCleanup = () => {
      if (child?.pid && !cleanupPromise) cleanupPromise = cleanupGroup(child.pid);
      return cleanupPromise ?? Promise.resolve();
    };
    const finish = async (finishedExitCode, finishedSignal, processError, skipCleanup = false) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (signal) signal.removeEventListener('abort', cancel);
      let cleanupError = null;
      if (!skipCleanup) {
        try {
          await beginCleanup();
        } catch (error) {
          cleanupError = error;
        }
      }
      const error = combineFailures(processError, cleanupError) ?? callbackError;
      const status = error ? 'fail' : (requestedStatus ?? (finishedExitCode !== 0 ? 'fail' : 'pass'));
      const result = { id, status, exitCode: finishedExitCode ?? null, signal: finishedSignal ?? null, elapsedMs: elapsed(), stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'), error: error ? errorData(error) : null };
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
    const cancel = () => terminate('cancelled');
    terminate = (status) => {
      if (finishing || requestedStatus) return;
      requestedStatus = status;
      if (!child?.pid) return;
      if (exited) {
        // The group ended after the exit of the leader and the output stays open: a process outside the group holds it. The limit ends
        // the wait for its end, and the result names the cause.
        child.stdout.destroy();
        child.stderr.destroy();
        const running = groupRuns(child.pid) ? `; the group still runs: ${named(runningMembers(child.pid))}` : '; a process outside the group holds it';
        const error = new Error(`the output of the command stayed open until its limit after its leader exited${running}`);
        error.code = 'OUTPUT_HELD_OUTSIDE_GROUP';
        finish(exitCode, exitSignal, error, true);
        return;
      }
      try {
        killGroup(child.pid);
      } catch (error) {
        reportSignalError(error);
      }
    };

    if (signal?.aborted) {
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
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const result = await runCommand({ ...parseCli(process.argv.slice(2)), signal: controller.signal });
    process.exitCode = result.status === 'pass' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

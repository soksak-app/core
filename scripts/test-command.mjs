import childProcess, { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
  return { name: error.name, message: error.message, ...(error.code ? { code: error.code } : {}), ...(error.path ? { path: error.path } : {}) };
}

function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

// kill(-pgid, sig) of macOS returns EPERM when the group has no member that can receive the signal. A member that has ended but whose parent has not yet reaped it
// (a zombie) stays in the group until it is reaped, and a group that holds only zombies also receives this answer. So a rejected check
// reads the members of the group and their states from the process table and judges from them.
export function groupMembers(pgid) {
  const table = childProcess.execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  const members = [];
  for (const line of table.split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.trim().split(/\s+/);
    const memberPid = Number(fields[0]);
    const memberGroup = Number(fields[1]);
    if (fields.length !== 3 || !Number.isInteger(memberPid) || !Number.isInteger(memberGroup)) throw new Error(`ps returned an unreadable process line: ${JSON.stringify(line)}`);
    if (memberGroup === pgid) members.push({ pid: memberPid, state: fields[2] });
  }
  return members;
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    // The rejected signal and the group must be kept to tell which step's signal failed. The code is left as it is.
    error.message = `${signal} to process group ${pid}: ${error.message}`;
    throw error;
  }
}

async function cleanupGroup(pid, termAlreadySent = false) {
  const observations = [];
  let lastError;
  const observedErrors = new Set();
  const record = (operation, error, members) => {
    lastError = error;
    const key = operation + ":" + error.code;
    if (!observedErrors.has(key)) observations.push({ operation, error: errorData(error), ...(members ? { members } : {}) });
    observedErrors.add(key);
  };
  const gone = () => {
    try { return !groupExists(pid); }
    catch (error) {
      if (error.code !== 'EPERM') throw error;
      // The rejection alone does not show absence. When the process table has no running member (none, or only zombies), the group has no process to end.
      const members = groupMembers(pid);
      record('verify', error, members);
      return members.every((member) => member.state.startsWith('Z'));
    }
  };
  const signal = (name) => {
    try { signalGroup(pid, name); }
    catch (error) {
      if (error.code !== 'EPERM') throw error;
      record(name, error);
    }
  };
  const waitGone = async () => {
    const deadline = performance.now() + 150;
    do {
      if (gone()) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (performance.now() < deadline);
    return gone();
  };
  if (gone()) return observations;
  if (!termAlreadySent) signal('SIGTERM');
  if (await waitGone()) return observations;
  signal('SIGKILL');
  if (await waitGone()) return observations;
  const error = lastError ?? new Error(`process group ${pid} survived cleanup`);
  if (!error.code) error.code = 'PROCESS_GROUP_CLEANUP_FAILED';
  error.cleanupObservations = observations;
  throw error;
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
    let forceKillTimer;
    let signalFailureTimer;
    let closeTimer;
    let finishing = false;
    let closeSeen = false;
    let requestedStatus;
    let termSent = false;
    let cleanupPromise;
    let exitCode;
    let exitSignal;
    const stdoutChunks = [];
    const stderrChunks = [];

    const beginCleanup = () => {
      if (child?.pid && !cleanupPromise) cleanupPromise = cleanupGroup(child.pid, termSent);
      return cleanupPromise ?? Promise.resolve([]);
    };
    const finish = async (finishedExitCode, finishedSignal, processError, skipCleanup = false) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      clearTimeout(forceKillTimer);
      clearTimeout(signalFailureTimer);
      clearTimeout(closeTimer);
      if (signal) signal.removeEventListener('abort', cancel);
      let cleanupError = processError;
      let cleanupObservations = [];
      if (!skipCleanup) {
        try {
          cleanupObservations = await beginCleanup();
        } catch (error) {
          cleanupError = cleanupError ?? error;
          cleanupObservations = error.cleanupObservations ?? [];
        }
      }
      const error = cleanupError ?? callbackError;
      const status = error ? 'fail' : (requestedStatus ?? (finishedExitCode !== 0 ? 'fail' : 'pass'));
      const result = { id, status, exitCode: finishedExitCode ?? null, signal: finishedSignal ?? null, elapsedMs: elapsed(), stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'), error: error ? errorData(error) : null, cleanupObservations };
      const observerError = send(status, { exitCode: result.exitCode, signal: result.signal, error: result.error, cleanupObservations }, true);
      if (observerError) {
        result.status = 'fail';
        result.error = errorData(observerError);
      }
      resolve(result);
    };
    const reportSignalError = (error) => {
      callbackError = callbackError ?? error;
      process.stderr.write(`command process-group signal failed: ${error.message}\n`);
      if (!signalFailureTimer) {
        signalFailureTimer = setTimeout(() => {
          if (!finishing) {
            child.stdout.destroy();
            child.stderr.destroy();
            finish(exitCode, exitSignal, error, true);
          }
        }, 150);
      }
    };
    const cancel = () => terminate('cancelled');
    terminate = (status) => {
      if (finishing || requestedStatus) return;
      requestedStatus = status;
      if (child?.pid) {
        try {
          signalGroup(child.pid, 'SIGTERM');
          termSent = true;
        } catch (error) {
          reportSignalError(error);
        }
        forceKillTimer = setTimeout(() => {
          if (!finishing && child?.pid) {
            try {
              signalGroup(child.pid, 'SIGKILL');
            } catch (error) {
              // macOS rejects with EPERM a forced termination sent to a group in which SIGTERM ended every member and only zombies remain. The cleanup
              // step checks whether a running member remains in the group and fails then if one remains. Another rejection is a signal failure.
              if (error.code !== 'EPERM') reportSignalError(error);
              else process.stderr.write(`command process-group signal refused: ${error.message}; cleanup verifies the group\n`);
            }
          }
        }, 100);
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
      clearTimeout(timer);
      clearInterval(heartbeat);
      const cleanup = beginCleanup();
      cleanup.then(() => {
        if (!closeSeen && !finishing) {
          closeTimer = setTimeout(() => {
            if (!closeSeen && !finishing) {
              child.stdout.destroy();
              child.stderr.destroy();
              const error = new Error('child output streams did not drain after cleanup');
              error.code = 'OUTPUT_DRAIN_TIMEOUT';
              finish(exitCode, exitSignal, error, true);
            }
          }, 200);
        }
      }, (error) => {
        if (!closeSeen && !finishing) {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(exitCode, exitSignal, error, true);
        }
      });
    });
    child.once('close', (closedExitCode, closedSignal) => {
      closeSeen = true;
      finish(closedExitCode, closedSignal);
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

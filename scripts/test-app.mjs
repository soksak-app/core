// Runs the end-to-end checks of core on this computer (docs/operations/examples.md#end-to-end-run):
//   node scripts/test-app.mjs --script <name> [--native <target>] [--only <file>]... [--defaults Name=Value]...
// The e2e targets of the Makefile build the three debug applications, and then run this script with the window-check script of their
// tier (`verify`, `test-app:activation`) and the native end-to-end target of that tier. Each run
// makes a new configuration root under target/e2e, prepares the registry certificates in it and installs every plugin of the fixture
// registry of the core fixtures (`make build-fixture-registry`, target/fixture-registry) into the configuration of each application with
// the `sok` of that application, starts the applications with that root, runs the window checks and the native end-to-end target, quits the
// applications through the quit item of the application menu and the last one through the quit key, and fails when an application
// ends with another status than 0 or when a process of the root or of an application artifact remains. The application artifacts,
// the quit, the lock release wait, the native end-to-end tests, the process list and the crash reports are platform operations
// (scripts/platform/platform.js); a platform that does not implement one fails the step with the name of that operation. A passed
// run removes its root; a failed run keeps it with the logs of the applications, so a second run starts from the same state as the
// first. Each step prints `running`, then `passed` or `failed` with its elapsed time, or `skipped` with the failed step that skipped it.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { connect } from '@soksak/client';
import { untilFolderState } from '@soksak/window-check/folder-wait.mjs';
import { applicationArtifact, applicationExecutables, crashReports, listProcesses, quitApplication as requestQuit, runNativeTests,
  verifyApplicationArtifact, waitForLockRelease } from './platform/platform.js';
import { fixturePluginIds } from './fixture-registry.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APPS = ['wailsv3', 'tauriv2', 'mygo'];
/** The limit of a start step: the time that an application has to write endpoint.json. */
const START_LIMIT_MS = 60_000;
/** The limit of a services step: the time that a persistent service has to exit after its folder is removed. */
const SERVICE_END_LIMIT_MS = 30_000;
/** The limit of a quit step: the time that an application has to exit after its quit item or its quit key. */
const QUIT_LIMIT_MS = 60_000;

const configDir = (configRoot, app) => join(configRoot, `soksak-check-${app}`);

/** A new empty configuration root of one run, `<root>/target/e2e/<time>-<random>`. */
export function newConfigRoot(root) {
  const base = join(root, 'target', 'e2e');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-`));
}

/**
 * Reads the `Name=Value` entries of `--defaults` into an object. The name follows the rule of the hosts for a pair of the argument
 * domain (an identifier); an entry without `=`, with an empty value, or with a name given twice is an error.
 */
export function parseDefaults(entries) {
  const pairs = {};
  for (const entry of entries) {
    const at = entry.indexOf('=');
    const name = at < 0 ? entry : entry.slice(0, at), value = at < 0 ? '' : entry.slice(at + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`--defaults ${entry}: the name is not an identifier`);
    if (value === '') throw new Error(`--defaults ${entry}: the value is empty`);
    if (Object.hasOwn(pairs, name)) throw new Error(`--defaults ${name} is given twice`);
    pairs[name] = value;
  }
  return pairs;
}

/**
 * The steps of a run. A step of the phase `prepare` that fails skips every later step except those of `cleanup`; a failed `check`
 * skips nothing. `run` runs a command to its end, `verify` verifies that the application artifact is complete as its build signed it, `start` starts an application and ends when it writes endpoint.json, `native` runs
 * the native end-to-end tests `target` of the platform, `quit` quits a started application as a person does, through the quit item of
 * its menu (`by` `menu`) or through the quit key of the platform (`by` `key`), and `remaining` fails on a process whose executable or
 * arguments name the configuration root or an application artifact. `platform` selects the platform operations, the running
 * platform when it is not given; the plan carries it to each step that runs a platform operation and carries no detail of how a
 * platform performs that operation. The plan resolves the application executables of the platform, so a platform that does not
 * implement the application artifact fails before any step starts an application. `fixtures` are the plugin ids of the fixture
 * registry, which each application installs; they are read from e2e/fixtures of this checkout when not given. `defaults` are the
 * `Name=Value` entries of `--defaults`: each started application gets the pair `-Name Value` of the macOS argument domain
 * (docs/spec/hosts.md#application-arguments), so the value holds for that process alone, and the window checks read the entries as
 * the JSON object SOKSAK_DEFAULTS.
 */
export async function e2ePlan({ root, configRoot, script, native, only, platform, fixtures = fixturePluginIds(), defaults = [] }) {
  // `only` is one file selector or the list of a repeated --only, which scripts/node-tests.mjs widens to the files that hold any of them.
  const onlies = only === undefined ? [] : [only].flat();
  const defaultsPairs = parseDefaults(defaults);
  const env = { SOKSAK_CONFIG_ROOT: configRoot };
  const ca = join(configRoot, 'soksak-check-registry-tls', 'ca.pem');
  // The application artifact of each application: the debug build output of the checkout.
  const located = new Map();
  const executables = new Map();
  for (const app of APPS) {
    const artifact = await applicationArtifact(join(root, 'target', 'debug'), app, { platform });
    located.set(app, artifact);
    executables.set(app, await applicationExecutables(artifact, app, { platform }));
  }
  const appBinary = (app) => executables.get(app).application;
  // The run installs the fixture registry that `make build-fixture-registry` of E2E_BUILD wrote.
  const registry = join(root, 'target', 'fixture-registry', 'index.json');
  return [
    { name: 'registry certificates', phase: 'prepare', kind: 'run', argv: ['make', 'create-test-certificates'], env },
    ...APPS.flatMap((app) => {
      const { sok } = executables.get(app);
      const config = ['--config-dir', configDir(configRoot, app)];
      return [
        { name: `registry ${app}`, phase: 'prepare', kind: 'run', argv: [sok, 'registry', 'use', registry, ...config], env },
        ...fixtures.map((id) => ({
          name: `install ${id} ${app}`, phase: 'prepare', kind: 'run', argv: [sok, 'plugin', 'install', id, ...config], env,
        })),
      ];
    }),
    // Each application starts right after the verification of the signature of its artifact, so a run never starts an artifact that a
    // build left half written (docs/operations/examples.md#end-to-end-run).
    ...APPS.flatMap((app) => [
      { name: `verify artifact ${app}`, phase: 'prepare', kind: 'verify', artifact: located.get(app), platform },
      {
        name: `start ${app}`, phase: 'prepare', kind: 'start', app, configDir: configDir(configRoot, app), output: join(configRoot, `${app}.out`),
        argv: [appBinary(app), '--config-dir', configDir(configRoot, app), '--registry-ca', ca,
          ...Object.entries(defaultsPairs).flatMap(([name, value]) => [`-${name}`, value])],
      },
    ]),
    {
      name: 'window checks', phase: 'check', kind: 'run',
      argv: ['node', 'scripts/node-tests.mjs', '--script', script, '--concurrency', '1', '--timeout', '600', ...onlies.flatMap((value) => ['--only', value])],
      env: {
        ...env,
        ...Object.fromEntries(APPS.map((app) => [`SOKSAK_BINARY_${app.toUpperCase()}`, appBinary(app)])),
        SOKSAK_CANDIDATE_REGISTRY: pathToFileURL(registry).href,
        ...(defaults.length ? { SOKSAK_DEFAULTS: JSON.stringify(defaultsPairs) } : {}),
      },
    },
    ...(native === undefined ? [] : [{ name: 'native end-to-end tests', phase: 'check', kind: 'native', target: native, platform, env }]),
    // A person quits through the quit item of the application menu or through the quit key: each application ends by the item and the
    // last one by the key, and the run, the parent of each process, checks that it exits with status 0.
    ...APPS.map((app, index) => ({
      name: `quit ${app}`, phase: 'cleanup', kind: 'quit', by: index === APPS.length - 1 ? 'key' : 'menu', app, configDir: configDir(configRoot, app),
      platform,
    })),
    // A persistent service exits when its folder is removed (docs/spec/persistent-services.md), and a quit keeps the services, so the run
    // removes them before its audit of the processes.
    { name: 'persistent services end', phase: 'cleanup', kind: 'services', directories: APPS.map((app) => join(configDir(configRoot, app), 'services')), platform },
    { name: 'remaining processes', phase: 'cleanup', kind: 'remaining', paths: [configRoot, ...APPS.map((app) => located.get(app))], platform },
  ];
}

/**
 * The processes of `processes`, `{pid, ppid, executable, arguments}` records, whose executable or arguments name one of the paths,
 * except the process `self`, each as `<pid> <arguments>`.
 */
export function remainingProcesses(processes, paths, self = process.pid) {
  return processes.filter(({ pid, executable, arguments: line }) => pid !== self
    && paths.some((path) => (executable !== null && executable.includes(path)) || line.includes(path))).map(({ pid, arguments: line }) => `${pid} ${line}`);
}

/** The end of a child: `{code, signal}` once it exits, also when it exited before the call. */
function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return once(child, 'exit').then(([code, signal]) => ({ code, signal }));
}

const describeExit = ({ code, signal }) => (signal === null ? `code ${code}` : `signal ${signal}`);

/** Rejects with `message` after `ms`; the returned `clear` stops the timer. */
function limit(ms, message) {
  let timer;
  const promise = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return { promise, clear: () => clearTimeout(timer) };
}

/** An error that states that a signal interrupted the run; the run stops its checks and runs its cleanup steps. */
class Interrupted extends Error {}

const interruptedBy = (signal) => new Interrupted(`interrupted by ${signal.reason}`);

/** Runs a command; an interrupt of the run ends the command with SIGTERM and rejects with Interrupted. */
async function runCommand(item, interrupted) {
  const child = spawn(item.argv[0], item.argv.slice(1), { cwd: ROOT, env: { ...process.env, ...item.env }, stdio: 'inherit' });
  const stop = () => child.kill('SIGTERM');
  interrupted?.addEventListener('abort', stop, { once: true });
  try {
    const [result] = await Promise.race([
      exited(child).then((end) => [end]),
      once(child, 'error').then(([error]) => { throw new Error(`cannot start ${item.argv[0]}: ${error.message}`); }),
    ]);
    if (interrupted?.aborted) throw interruptedBy(interrupted);
    if (result.code !== 0) throw new Error(`exited with ${describeExit(result)}`);
  } finally {
    interrupted?.removeEventListener('abort', stop);
  }
}

/**
 * Starts an application and resolves when its configuration folder holds endpoint.json. The folder is read once its change watch is
 * active and again at each change (untilFolderState), so a file written before the watch became active is found too. The wait ends
 * with an error when the application cannot start or exits first; a start that fails ends the process that it started and leaves
 * no started application, so the quit step of that application is skipped.
 */
async function startApplication(item, children) {
  mkdirSync(item.configDir, { recursive: true });
  const endpoint = join(item.configDir, 'endpoint.json');
  const output = openSync(item.output, 'a');
  const child = spawn(item.argv[0], item.argv.slice(1), { cwd: ROOT, stdio: ['ignore', output, output] });
  children.set(item.app, child);
  const ended = new AbortController();
  child.once('error', (error) => ended.abort(new Error(`cannot start ${item.argv[0]}: ${error.message}`)));
  exited(child).then((end) => ended.abort(new Error(`the application exited with ${describeExit(end)} before it wrote endpoint.json`)));
  // The folder wait has no time limit; the run bounds its start step with its own limit, which it gives the wait as an abort.
  const limit = AbortSignal.timeout(START_LIMIT_MS);
  try {
    try {
      await untilFolderState(item.configDir, () => (existsSync(endpoint) ? true : undefined), { signal: AbortSignal.any([ended.signal, limit]) });
    } catch (error) {
      if (limit.aborted && !ended.signal.aborted) throw new Error(`the application wrote no endpoint.json in ${START_LIMIT_MS / 1000}s`);
      throw error;
    }
  } catch (error) {
    // An application that did not start has no endpoint for a quit step: the start ends a process that still runs, and the quit
    // step of the application is skipped as for an application that was not started.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited(child);
    }
    children.delete(item.app);
    throw error;
  }
}

/**
 * Quits an application by its item and waits for its exit and its lock release. `limitMs` is the limit of the quit step; runPlan
 * passes QUIT_LIMIT_MS, and a test passes its own limit so that the expiry is observed without a fake clock. A quit that fails while
 * the started process still runs ends that process with SIGKILL and waits for its exit, because a process that a check started ends
 * when the check ends; the step still fails, and its failure names that end. A host that relaunches itself replaces its process: the
 * handle then names a process that already ended. The owner that process.lock names is the replacement, so the quit follows it: the
 * replacement is quit normally, as the handle would be, and the step fails with the reason of the first quit and the replacement's pid.
 * A replacement that does not quit is ended with SIGKILL, and the failure names it.
 */
export async function quitApplication(item, children, since, write, connectClient = connect, lockRelease = waitForLockRelease,
  limitMs = QUIT_LIMIT_MS, processes = listProcesses) {
  if (typeof limitMs !== 'number' || !Number.isFinite(limitMs) || limitMs <= 0) throw new Error(`quitApplication needs a limit of more than 0 ms, not ${limitMs}`);
  const child = children.get(item.app);
  try {
    await quitNormally(item, (pid) => (pid === child.pid ? exited(child) : processEnding(pid, processes, item.platform, limitMs)),
      since, write, connectClient, lockRelease, limitMs);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited(child);
      throw new Error(`${error.message}; the application still ran and was ended with SIGKILL`);
    }
    // The application ended with its own status: that status is the result of the quit that it received.
    if (error.exitStatus === true) throw error;
    await followReplacement(item, child, error, { write, connectClient, lockRelease, since, limitMs, processes });
  }
}

/**
 * Follows the replacement of a handle that already ended. The owner pid of `<config-dir>/process.lock` is read with the folder watch
 * (docs/spec/endpoint.md), once the owner differs from the handle and endpoint.json exists; the wait is bounded by `limitMs`. The
 * owner is quit as the application is quit, and its end is read from the process table, because it is not a child of this run. The
 * step always fails with the reason of the first quit: a replacement that quit normally is named, and one that did not is ended with
 * SIGKILL and named, so no end of a replacement is silent.
 */
async function followReplacement(item, handle, failure, { write, connectClient, lockRelease, since, limitMs, processes }) {
  const { configDir } = item;
  if (typeof configDir !== 'string' || configDir.length === 0) throw new Error(`${failure.message}; quit ${item.app} has no configuration directory to follow`);
  const owner = await replacementOwner(configDir, handle.pid, limitMs, processes, item.platform);
  if (owner === null) throw new Error(`${failure.message}; process.lock of ${configDir} named no running replacement within ${limitMs / 1000}s`);
  write(`following the replacement ${owner.pid} of ${item.app} that process.lock names`);
  try {
    await quitNormally(item, (pid) => processEnding(pid, processes, item.platform, limitMs), since, write, connectClient, lockRelease, limitMs);
  } catch (quitError) {
    let killed = false;
    try { process.kill(owner.pid, 'SIGKILL'); killed = true; }
    catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
    throw new Error(`${failure.message}; the replacement ${owner.pid} named by process.lock did not quit (${quitError.message})` +
      (killed ? ` and was ended with SIGKILL` : ` and had already ended`));
  }
  throw new Error(`${failure.message}; the replacement ${owner.pid} named by process.lock quit normally`);
}

/**
 * The owner that `<config-dir>/process.lock` names once it differs from `handlePid`, endpoint.json exists and the owner is listed as
 * running, or null when `limitMs` expires first. The folder watch is the event source of the file, and the wait ends by the signal of
 * its limit.
 */
async function replacementOwner(configDir, handlePid, limitMs, processes, platform) {
  const lock = join(configDir, 'process.lock');
  const endpoint = join(configDir, 'endpoint.json');
  const aborted = new AbortController();
  const timer = setTimeout(() => aborted.abort(), limitMs);
  let pid;
  try {
    pid = await untilFolderState(configDir, () => {
      if (!existsSync(lock) || !existsSync(endpoint)) return undefined;
      const text = readFileSync(lock, 'utf8').trim();
      if (text === '') return undefined;
      const record = JSON.parse(text);
      if (!Number.isInteger(record?.pid) || record.pid <= 0) throw new Error(`${lock} names no owning pid: ${text}`);
      return record.pid === handlePid ? undefined : record.pid;
    }, { signal: aborted.signal });
  } catch (error) {
    if (aborted.signal.aborted) return null;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const listed = (await processes({ platform })).some((row) => row.pid === pid);
  if (!listed) throw new Error(`${join(configDir, 'process.lock')} names pid ${pid}, which is not running`);
  return { pid };
}

/**
 * The end of a process that is not a child of this run: its absence from the process table (docs/spec/verification.md#process-table).
 * A process table has no wait status for it, so the end reads the table until the pid is absent, bounded by `limitMs`.
 */
async function processEnding(pid, processes, platform, limitMs) {
  const bound = Date.now() + limitMs;
  for (;;) {
    const listed = (await processes({ platform })).some((row) => row.pid === pid);
    if (!listed) return { code: 0, signal: null };
    if (Date.now() >= bound) throw new Error(`process ${pid} did not end in ${limitMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The failure of a quit whose application ended with its own exit status: that status is the result of the quit, so no replacement is followed. */
function exitStatusError(message) {
  return Object.assign(new Error(message), { exitStatus: true });
}

async function quitNormally(item, ending, since, write, connectClient, lockRelease, limitMs) {
  let client;
  let expired = false;
  const bound = limit(limitMs, `the normal quit did not complete in ${limitMs / 1000}s`);
  let action;
  try {
    action = await Promise.race([
      (async () => {
        const connected = await connectClient({ configDir: item.configDir });
        if (expired) {
          // Connection establishment is not cancellable. A late connection
          // belongs to the expired step and must never dispatch a new Quit.
          connected.close();
          throw new Error('the normal quit deadline expired before connection');
        }
        client = connected;
        // The process that answers this connection is the one that the quit reaches, so its end is the end of the quit: the handle
        // of the start step is not necessarily that process (a relaunched host answers from its replacement).
        const target = connected.endpoint?.pid;
        if (!Number.isInteger(target) || target <= 0) throw new Error(`the connection to ${item.configDir} names no process of ${item.app}`);
        const selected = await requestQuit(connected, item.by, { platform: item.platform });
        if (expired) throw new Error('the normal quit deadline expired before its response');
        connected.close();
        client = undefined;
        const end = await ending(target);
        if (end.code !== 0) {
          const ended = `the application ended with ${describeExit(end)}`;
          // A platform without crash reports names that operation in the failure, which keeps the exit status.
          let reports;
          try { reports = await crashReports(item.app, since, { platform: item.platform }); }
          catch (error) { throw exitStatusError(`${ended}; ${error.message}`); }
          for (const { report, fault } of reports) write(`crash ${report}: ${JSON.stringify(fault)}`);
          throw exitStatusError(ended);
        }
        return selected;
      })(),
      bound.promise,
    ]);
  } finally {
    expired = true;
    client?.close();
    client = undefined;
    bound.clear();
  }
  // Retain the existing lock-holder proof, including a replacement process
  // after relaunch. A timeout above is a failed Quit; the end of a process that still runs belongs to quitApplication.
  await lockReleased(item.configDir, action, item.platform, lockRelease, limitMs);
}

/**
 * Waits until no process holds `<config-dir>/process.lock` (docs/spec/endpoint.md). The started process is not always the owner:
 * diagnostics.host.relaunch replaces it with a new process. The lock release wait of the platform returns when the owner exits.
 */
async function lockReleased(configDir, action, platform, lockRelease, limitMs) {
  const lock = join(configDir, 'process.lock');
  if (!existsSync(lock)) return;
  if (!await lockRelease(lock, limitMs / 1000, { platform })) {
    throw new Error(`the process that holds ${lock} did not exit in ${limitMs / 1000}s after ${action}`);
  }
}

async function checkRemaining(item, processes) {
  const found = remainingProcesses(await processes({ platform: item.platform }), item.paths);
  if (found.length > 0) throw new Error(`${found.length} processes remain: ${found.join('; ')}`);
}

/**
 * Removes the services folders of the run and waits until no process of the platform list names one of them. A service that stays
 * after its folder is removed is named by its pid in the failure of the step; the step does not end it.
 */
async function endServices(item, processes, limitMs) {
  const removed = [];
  for (const directory of item.directories) {
    if (!existsSync(directory)) continue;
    rmSync(directory, { recursive: true });
    removed.push(directory);
  }
  if (removed.length === 0) return;
  const named = ({ executable, arguments: line }) => removed.some((directory) => (executable !== null && executable.includes(directory)) || line.includes(directory));
  const bound = Date.now() + limitMs;
  for (;;) {
    const running = (await processes({ platform: item.platform })).filter(named);
    if (running.length === 0) return;
    if (Date.now() >= bound) {
      throw new Error(`the persistent services did not exit in ${limitMs / 1000}s after their folders were removed: ${running.map(({ pid }) => pid).join(', ')}`);
    }
    // A service exits by itself after its folder is removed, and the process table is the only record of its exit: a service of this run is not a child, so no wait status exists for it.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Runs the native end-to-end tests of the platform; an interrupt of the run ends them and rejects with Interrupted. */
async function runNative(item, interrupted) {
  try {
    await runNativeTests(item.target, { platform: item.platform, cwd: ROOT, env: { ...process.env, ...item.env }, signal: interrupted });
  } catch (error) {
    if (interrupted?.aborted) throw interruptedBy(interrupted);
    throw error;
  }
  if (interrupted?.aborted) throw interruptedBy(interrupted);
}

/**
 * Runs the steps in order and returns the failures as `<step>: <reason>`. `children` holds the started applications by name, so a quit
 * step reaches the application of an earlier start step. An abort of `interrupted`, whose reason is the name of the signal, ends the
 * running command, skips the later steps that are not cleanup steps and runs the cleanup steps, so the applications and their services end.
 * `lockRelease` and `processes` are the lock release wait and the process list of the platform; a test passes its own readers.
 * `quitLimitMs` is the limit of each quit step (QUIT_LIMIT_MS by default); a test passes a shorter limit.
 */
export async function runPlan(steps, { write, children = new Map(), interrupted, outcome = () => {}, connectClient = connect,
  lockRelease = waitForLockRelease, processes = listProcesses, quitLimitMs = QUIT_LIMIT_MS, serviceLimitMs = SERVICE_END_LIMIT_MS }) {
  const failures = [];
  const since = Date.now();
  let stopped = null;
  for (const item of steps) {
    if (stopped !== null && item.phase !== 'cleanup') {
      write(`skipped ${item.name}: ${stopped} failed`);
      outcome({ name: item.name, status: 'skip' });
      continue;
    }
    if (item.kind === 'quit' && !children.has(item.app)) {
      write(`skipped ${item.name}: ${item.app} was not started`);
      outcome({ name: item.name, status: 'skip' });
      continue;
    }
    if (interrupted?.aborted && item.phase !== 'cleanup') {
      write(`skipped ${item.name}: interrupted by ${interrupted.reason}`);
      outcome({ name: item.name, status: 'skip' });
      continue;
    }
    write(`running ${item.name}`);
    const from = performance.now();
    try {
      // A cleanup step runs to its end after an interrupt, because it ends what the earlier steps started.
      if (item.kind === 'run') await runCommand(item, item.phase === 'cleanup' ? undefined : interrupted);
      else if (item.kind === 'verify') await verifyApplicationArtifact(item.artifact, { platform: item.platform });
      else if (item.kind === 'start') await startApplication(item, children);
      else if (item.kind === 'quit') await quitApplication(item, children, since, write, connectClient, lockRelease, quitLimitMs, processes);
      else if (item.kind === 'native') await runNative(item, item.phase === 'cleanup' ? undefined : interrupted);
      else if (item.kind === 'services') await endServices(item, processes, serviceLimitMs);
      else if (item.kind === 'remaining') await checkRemaining(item, processes);
      else throw new Error(`unknown step kind ${JSON.stringify(item.kind)}`);
      if (interrupted?.aborted && item.phase !== 'cleanup') throw interruptedBy(interrupted);
      write(`passed ${item.name} ${((performance.now() - from) / 1000).toFixed(1)}s`);
      outcome({ name: item.name, status: 'pass' });
    } catch (error) {
      write(`failed ${item.name} ${((performance.now() - from) / 1000).toFixed(1)}s: ${error.message}`);
      failures.push(`${item.name}: ${error.message}`);
      outcome({ name: item.name, status: 'fail' });
      if (item.phase === 'prepare') stopped = item.name;
    }
  }
  return failures;
}

/**
 * Removes the configuration root of a passed run and keeps that of a failed run with its logs. A failed run removes the service folder
 * of each application, which holds only the endpoint and the lock of its persistent services, because a service exits when its folder
 * is removed (docs/spec/persistent-services.md) and a host that ended without host.quit did not shut its services down.
 */
export function finishRoot(configRoot, failures, write) {
  if (failures.length === 0) {
    rmSync(configRoot, { recursive: true });
    return;
  }
  for (const app of APPS) {
    const services = join(configDir(configRoot, app), 'services');
    if (!existsSync(services)) continue;
    rmSync(services, { recursive: true });
    write(`removed ${services}: the services of the run exit`);
  }
  write(`kept ${configRoot}: ${failures.length} step${failures.length === 1 ? '' : 's'} failed`);
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv, strict: true, options: { script: { type: 'string' }, native: { type: 'string' }, only: { type: 'string', multiple: true },
      defaults: { type: 'string', multiple: true } },
  });
  if (values.script === undefined) throw new Error('--script names the window-check script of the run');
  const write = (line) => process.stdout.write(`${line}\n`);
  // Reference installation and later check commands share cancellation and clean up their own children.
  const interrupt = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.once(signal, () => {
      write(`received ${signal}: the run ends its checks and runs its cleanup`);
      interrupt.abort(signal);
    });
  }
  const configRoot = newConfigRoot(ROOT);
  write(`run ${configRoot}`);
  const failures = await runPlan(await e2ePlan({ root: ROOT, configRoot, script: values.script, native: values.native, only: values.only,
    defaults: values.defaults ?? [] }), { write, interrupted: interrupt.signal });
  finishRoot(configRoot, failures, write);
  for (const failure of failures) write(`failure ${failure}`);
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

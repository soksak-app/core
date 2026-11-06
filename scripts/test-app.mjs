// Runs the end-to-end checks of core on this computer (docs/operations/examples.md#end-to-end-run):
//   node scripts/test-app.mjs --script <name> [--native <target>] [--when-idle <seconds>]
// The e2e targets of the Makefile build the three debug applications and the workspace registry, and then run this script with the
// window-check script of their tier (`verify`, `test-app:activation`, `test-app:real`, `test-app:person`) and the native end-to-end target
// of that tier. Each run makes a new configuration root under target/e2e, prepares the registry certificates and the plugins of the
// applications in it, starts the applications with that root, runs the window checks and the native end-to-end target, quits the
// applications through the Quit item of the application menu and the last one through Command+Q, and fails when an application ends
// with another status than 0 or when a process of
// the root or of a bundle remains. A passed run removes its root; a failed run keeps it with the logs of the applications, so a second
// run starts from the same state as the first. Each step prints `running`, then `passed` or `failed` with its elapsed time, or `skipped`
// with the failed step that skipped it.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { connect } from '@soksak/client';
import { untilFolderState } from '@soksak/window-check/folder-wait.mjs';
import { crashFault } from './crash-fault.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APPS = ['wailsv3', 'tauriv2', 'mygo'];
/** The limit of a start step: the time that an application has to write endpoint.json. */
const START_LIMIT_MS = 60_000;
/** The limit of a quit step: the time that an application has to exit after its Quit item or Command+Q. */
const QUIT_LIMIT_MS = 60_000;

const bundle = (root, app) => join(root, 'target', 'debug', `sok-${app}.app`);
const binary = (root, app) => join(bundle(root, app), 'Contents', 'MacOS', `sok-${app}`);
const configDir = (configRoot, app) => join(configRoot, `soksak-check-${app}`);

/** A new empty configuration root of one run, `<root>/target/e2e/<time>-<random>`. */
export function newConfigRoot(root) {
  const base = join(root, 'target', 'e2e');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-`));
}

/**
 * The steps of a run. A step of the phase `prepare` that fails skips every later step except those of `cleanup`; a failed `check`
 * skips nothing. `run` runs a command to its end, `start` starts an application and ends when it writes endpoint.json, `quit` quits a
 * started application through the Quit item of its menu (`by` `menu`) or Command+Q (`by` `key`), and `remaining` fails on a process whose command names the configuration root or a bundle.
 */
export function e2ePlan({ root, configRoot, script, native, whenIdle }) {
  const env = { SOKSAK_CONFIG_ROOT: configRoot };
  const ca = join(configRoot, 'soksak-check-registry-tls', 'ca.pem');
  return [
    { name: 'registry certificates', phase: 'prepare', kind: 'run', argv: ['make', 'create-test-certificates'], env },
    ...APPS.map((app) => ({
      name: `install plugins ${app}`, phase: 'prepare', kind: 'run', argv: ['make', 'install-plugins', `CONFIG=${configDir(configRoot, app)}`], env,
    })),
    ...APPS.map((app) => ({
      name: `start ${app}`, phase: 'prepare', kind: 'start', app, configDir: configDir(configRoot, app), output: join(configRoot, `${app}.out`),
      argv: [binary(root, app), '--config-dir', configDir(configRoot, app), '--registry-ca', ca],
    })),
    {
      name: 'window checks', phase: 'check', kind: 'run',
      argv: ['node', 'scripts/node-tests.mjs', '--script', script, '--concurrency', '1', '--timeout', '600', ...(whenIdle === undefined ? [] : ['--when-idle', whenIdle])],
      env: {
        ...env,
        ...Object.fromEntries(APPS.map((app) => [`SOKSAK_BINARY_${app.toUpperCase()}`, binary(root, app)])),
        SOKSAK_CANDIDATE_REGISTRY: pathToFileURL(join(root, 'target', 'registry', 'index.json')).href,
      },
    },
    ...(native === undefined ? [] : [{ name: 'native end-to-end tests', phase: 'check', kind: 'run', argv: ['make', '-C', 'native/darwin', native], env }]),
    // A person quits through the Quit item of the application menu or its key equivalent: each application ends by the item and the
    // last one by Command+Q, and the run, the parent of each process, checks that it exits with status 0.
    ...APPS.map((app, index) => ({
      name: `quit ${app}`, phase: 'cleanup', kind: 'quit', by: index === APPS.length - 1 ? 'key' : 'menu', app, configDir: configDir(configRoot, app),
    })),
    { name: 'remaining processes', phase: 'cleanup', kind: 'remaining', paths: [configRoot, ...APPS.map((app) => bundle(root, app))] },
  ];
}

/** The lines `<pid> <command>` of `ps -axo pid=,command=` whose command names one of the paths, except the process `self`. */
export function remainingProcesses(text, paths, self = process.pid) {
  return text.split('\n').map((line) => line.trim()).filter((line) => {
    const match = /^(\d+)\s+(.*)$/.exec(line);
    return match !== null && Number(match[1]) !== self && paths.some((path) => match[2].includes(path));
  });
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
  try {
    await untilFolderState(item.configDir, () => (existsSync(endpoint) ? true : undefined), START_LIMIT_MS,
      () => new Error(`the application wrote no endpoint.json in ${START_LIMIT_MS / 1000}s`), ended.signal);
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

/** The crash reports of the application that the system wrote since `since` (ms), each with the fault that names its address. */
function crashReports(app, since) {
  const folder = join(homedir(), 'Library', 'Logs', 'DiagnosticReports');
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.startsWith(`sok-${app}-`) && name.endsWith('.ips'))
    .map((name) => join(folder, name))
    .filter((file) => statSync(file).mtimeMs >= since)
    .map((file) => `${file}: ${JSON.stringify(crashFault(readFileSync(file, 'utf8'), file))}`);
}

/** The key equivalent of the Quit item of the application menu, as host.menu writes it. */
const QUIT_KEY = 'cmd+q';

/**
 * Quits the application through the path of a person (docs/operations/examples.md#end-to-end-run): `by` `menu` performs the item
 * of the application menu whose key equivalent is Command+Q with host.menu.select, and `by` `key` sends Command+Q down and up to a
 * window with input.key. Returns the name of the action for the messages of the step.
 */
async function requestQuit(client, by) {
  if (by === 'menu') {
    const { menus } = await client.request('status.get', { window: 'main', name: 'host.menu' });
    const menu = menus.find((entry) => entry.items.some((entry) => entry.key === QUIT_KEY));
    if (menu === undefined) throw new Error(`the application menu has no item with the key equivalent ${QUIT_KEY}`);
    const { title } = menu.items.find((entry) => entry.key === QUIT_KEY);
    const reply = await client.request('command.run', { window: 'main', name: 'host.menu.select', params: { menu: menu.title, title } });
    if (reply !== null) throw new Error(`host.menu.select of ${title} returned ${JSON.stringify(reply)}, expected null`);
    return `the item ${title}`;
  }
  if (by === 'key') {
    const [first] = await client.request('windows.list', {});
    if (first === undefined) throw new Error('the application has no window to take Command+Q');
    for (const phase of ['down', 'up']) {
      const reply = await client.request('input.key', { window: first.window, key: 'q', text: 'q', modifiers: ['command'], phase });
      if (reply !== null) throw new Error(`input.key ${phase} of Command+Q returned ${JSON.stringify(reply)}, expected null`);
    }
    return 'Command+Q';
  }
  throw new Error(`unknown quit path ${JSON.stringify(by)}`);
}

async function quitApplication(item, children, since, write) {
  const child = children.get(item.app);
  const client = await connect({ configDir: item.configDir });
  let action;
  try {
    action = await requestQuit(client, item.by);
  } finally {
    client.close();
  }
  const bound = limit(QUIT_LIMIT_MS, `the application did not exit in ${QUIT_LIMIT_MS / 1000}s after ${action}`);
  let end;
  try {
    end = await Promise.race([exited(child), bound.promise]);
  } finally {
    bound.clear();
  }
  if (end.code !== 0) {
    for (const line of crashReports(item.app, since)) write(`crash ${line}`);
    throw new Error(`the application ended with ${describeExit(end)}`);
  }
  await lockReleased(item.configDir, action);
}

/**
 * Waits until no process holds `<config-dir>/process.lock` (docs/spec/endpoint.md). The started process is not always the owner:
 * diagnostics.host.relaunch replaces it with a new process. lockf(1) takes the flock(2) lock that the host holds for its life, and
 * the kernel wakes it when the owner exits, so the wait needs no polling.
 */
async function lockReleased(configDir, action) {
  const lock = join(configDir, 'process.lock');
  if (!existsSync(lock)) return;
  const child = spawn('lockf', ['-s', '-t', String(QUIT_LIMIT_MS / 1000), lock, 'true'], { stdio: 'ignore' });
  const end = await Promise.race([
    exited(child),
    once(child, 'error').then(([error]) => { throw new Error(`cannot start lockf: ${error.message}`); }),
  ]);
  if (end.code !== 0) {
    throw new Error(`the process that holds ${lock} did not exit in ${QUIT_LIMIT_MS / 1000}s after ${action} (lockf ${describeExit(end)})`);
  }
}

function checkRemaining(item) {
  const found = remainingProcesses(execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 }), item.paths);
  if (found.length > 0) throw new Error(`${found.length} processes remain: ${found.join('; ')}`);
}

/**
 * Runs the steps in order and returns the failures as `<step>: <reason>`. `children` holds the started applications by name, so a quit
 * step reaches the application of an earlier start step. An abort of `interrupted`, whose reason is the name of the signal, ends the
 * running command, skips the later steps that are not cleanup steps and runs the cleanup steps, so the applications and their services end.
 */
export async function runPlan(steps, { write, children = new Map(), interrupted }) {
  const failures = [];
  const since = Date.now();
  let stopped = null;
  for (const item of steps) {
    if (stopped !== null && item.phase !== 'cleanup') {
      write(`skipped ${item.name}: ${stopped} failed`);
      continue;
    }
    if (item.kind === 'quit' && !children.has(item.app)) {
      write(`skipped ${item.name}: ${item.app} was not started`);
      continue;
    }
    if (interrupted?.aborted && item.phase !== 'cleanup') {
      write(`skipped ${item.name}: interrupted by ${interrupted.reason}`);
      continue;
    }
    write(`running ${item.name}`);
    const from = performance.now();
    try {
      // A cleanup step runs to its end after an interrupt, because it ends what the earlier steps started.
      if (item.kind === 'run') await runCommand(item, item.phase === 'cleanup' ? undefined : interrupted);
      else if (item.kind === 'start') await startApplication(item, children);
      else if (item.kind === 'quit') await quitApplication(item, children, since, write);
      else if (item.kind === 'remaining') checkRemaining(item);
      else throw new Error(`unknown step kind ${JSON.stringify(item.kind)}`);
      if (interrupted?.aborted && item.phase !== 'cleanup') throw interruptedBy(interrupted);
      write(`passed ${item.name} ${((performance.now() - from) / 1000).toFixed(1)}s`);
    } catch (error) {
      write(`failed ${item.name} ${((performance.now() - from) / 1000).toFixed(1)}s: ${error.message}`);
      failures.push(`${item.name}: ${error.message}`);
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
    args: argv, strict: true, options: { script: { type: 'string' }, native: { type: 'string' }, 'when-idle': { type: 'string' } },
  });
  if (values.script === undefined) throw new Error('--script names the window-check script of the run');
  const write = (line) => process.stdout.write(`${line}\n`);
  const configRoot = newConfigRoot(ROOT);
  write(`run ${configRoot}`);
  // An interrupting signal ends the running step and runs the cleanup steps and finishRoot, so no application or service of the run remains.
  const interrupt = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.once(signal, () => {
      write(`received ${signal}: the run ends its checks and runs its cleanup`);
      interrupt.abort(signal);
    });
  }
  const failures = await runPlan(e2ePlan({ root: ROOT, configRoot, script: values.script, native: values.native, whenIdle: values['when-idle'] }),
    { write, interrupted: interrupt.signal });
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

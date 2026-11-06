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
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { connect } from '@soksak/client';
import { untilFolderState } from '@soksak/window-check/folder-wait.mjs';
import { crashFault } from './crash-fault.mjs';
import { collectAcceptanceInputs, finishAcceptanceRun, prepareCandidate } from './acceptance-run.mjs';
import { CANDIDATE_HOSTS, candidateScripts } from './candidate-policy.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APPS = ['wailsv3', 'tauriv2', 'mygo'];
/** The limit of a start step: the time that an application has to write endpoint.json. */
const START_LIMIT_MS = 60_000;
/** The limit of a quit step: the time that an application has to exit after its Quit item or Command+Q. */
const QUIT_LIMIT_MS = 60_000;

const bundle = (root, app) => join(root, 'target', 'debug', `sok-${app}.app`);
const configDir = (configRoot, app) => join(configRoot, `soksak-check-${app}`);
const nativeTarget = (script) => script === 'test-app' ? 'test-app' : script === 'test-app:activation' ? 'test-app-activation' : undefined;

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
export function e2ePlan({ root, configRoot, script, native, whenIdle, candidate, runFolder }) {
  const env = { SOKSAK_CONFIG_ROOT: configRoot };
  const ca = join(configRoot, 'soksak-check-registry-tls', 'ca.pem');
  const appBundle = (app) => candidate ? candidate.hosts.find((host) => host.app === app).bundle : bundle(root, app);
  const appBinary = (app) => join(appBundle(app), 'Contents', 'MacOS', `sok-${app}`);
  const registry = candidate ? candidate.registry.path : join(root, 'target', 'registry', 'index.json');
  return [
    // The model of each recognition language is compiled here, under the limit of the warm-up, before any application starts.
    { name: 'capture text warm-up', phase: 'prepare', kind: 'run', argv: ['node', 'e2e/setup.mjs'], env },
    { name: 'registry certificates', phase: 'prepare', kind: 'run', argv: ['make', 'create-test-certificates'], env },
    ...(candidate ? APPS.flatMap((app) => {
      const sok = join(appBundle(app), 'Contents', 'MacOS', 'sok');
      const config = ['--config-dir', configDir(configRoot, app)];
      return [
        { name: `registry ${app}`, phase: 'prepare', kind: 'run', argv: [sok, 'registry', 'use', registry, ...config], env },
        ...candidate.registry.components.filter((item) => item.kind === 'plugin').map(({ id }) => ({
          name: `install ${id} ${app}`, phase: 'prepare', kind: 'run', argv: [sok, 'plugin', 'install', id, ...config], env,
        })),
      ];
    }) : APPS.map((app) => ({
      name: `install plugins ${app}`, phase: 'prepare', kind: 'run', argv: ['make', 'install-plugins', `CONFIG=${configDir(configRoot, app)}`], env,
    }))),
    ...APPS.map((app) => ({
      name: `start ${app}`, phase: 'prepare', kind: 'start', app, configDir: configDir(configRoot, app), output: join(configRoot, `${app}.out`),
      argv: [appBinary(app), '--config-dir', configDir(configRoot, app), '--registry-ca', ca],
    })),
    ...(candidate ? [{ name: 'acceptance before', phase: 'prepare', kind: 'capture', capture: 'before' }] : []),
    {
      name: 'window checks', phase: 'check', kind: 'run',
      argv: ['node', 'scripts/node-tests.mjs', '--script', script, '--concurrency', '1', '--timeout', '600', ...(whenIdle === undefined ? [] : ['--when-idle', whenIdle])],
      env: {
        ...env,
        ...Object.fromEntries(APPS.map((app) => [`SOKSAK_BINARY_${app.toUpperCase()}`, appBinary(app)])),
        SOKSAK_CANDIDATE_REGISTRY: pathToFileURL(registry).href,
        ...(candidate ? { SOKSAK_CANDIDATE_RUN_FOLDER: runFolder } : {}),
      },
    },
    ...(native === undefined ? [] : [{ name: 'native end-to-end tests', phase: 'check', kind: 'run', argv: ['make', '-C', 'native/darwin', native],
      env: { ...env, ...(candidate ? { SOKSAK_NATIVE_TEST_RUN_FOLDER: join(runFolder, 'native') } : {}) } }]),
    ...(candidate ? [{ name: 'acceptance after', phase: 'cleanup', kind: 'capture', capture: 'after' }] : []),
    // A person quits through the Quit item of the application menu or its key equivalent: each application ends by the item and the
    // last one by Command+Q, and the run, the parent of each process, checks that it exits with status 0.
    ...APPS.map((app, index) => ({
      name: `quit ${app}`, phase: 'cleanup', kind: 'quit', by: index === APPS.length - 1 ? 'key' : 'menu', app, configDir: configDir(configRoot, app),
    })),
    { name: 'remaining processes', phase: 'cleanup', kind: 'remaining', paths: [configRoot, ...APPS.map(appBundle)] },
  ];
}

/** The required terminal steps use placeholder locations so the publication gate needs no workstation path. */
export function candidatePlanNames(context, script) {
  const candidate = { registry: { ...context.registry, path: '/candidate/index.json' },
    hosts: CANDIDATE_HOSTS.map((app) => ({ app, bundle: `/candidate/${app}.app` })) };
  return [...e2ePlan({ root: '/source', configRoot: '/configuration', runFolder: '/run', script,
    native: nativeTarget(script), candidate }).map(({ name }) => name), 'acceptance after cleanup', 'reference cleanup', 'configuration cleanup'];
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
export async function runPlan(steps, { write, children = new Map(), interrupted, capture, outcome = () => {} }) {
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
      else if (item.kind === 'start') await startApplication(item, children);
      else if (item.kind === 'quit') await quitApplication(item, children, since, write);
      else if (item.kind === 'remaining') checkRemaining(item);
      else if (item.kind === 'capture') await capture(item.capture);
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

/** Completes the recorded candidate plan and attaches its actual outcomes to the retained window manifest. */
export async function finishCandidate({ root, context, configRoot, runFolder, script, initializationId, inputs, steps, failures, dispose, write },
  { capture = collectAcceptanceInputs, cleanup = finishRoot } = {}) {
  try {
    inputs.afterCleanup = await capture(root, context, configRoot, { live: false });
    steps.push({ name: 'acceptance after cleanup', status: 'pass' });
  } catch (error) {
    failures.push(`acceptance after cleanup: ${error.message}`);
    steps.push({ name: 'acceptance after cleanup', status: 'fail' });
  }
  try {
    await dispose();
    steps.push({ name: 'reference cleanup', status: 'pass' });
  } catch (error) {
    failures.push(`reference cleanup: ${error.message}`);
    steps.push({ name: 'reference cleanup', status: 'fail' });
  }
  const plan = { status: failures.length ? 'fail' : 'pass', steps };
  const acceptance = await finishAcceptanceRun({ runFolder, context, script, initializationId,
    ...inputs, plan, errors: failures, finalize: async (findings) => {
      for (const error of findings) if (!failures.includes(error)) failures.push(error);
      try {
        cleanup(configRoot, failures, write);
        steps.push({ name: 'configuration cleanup', status: 'pass' });
      } catch (error) {
        const message = `configuration cleanup: ${error.message}`;
        failures.push(message);
        findings.push(message);
        steps.push({ name: 'configuration cleanup', status: 'fail' });
      }
      plan.status = failures.length ? 'fail' : 'pass';
    } });
  for (const error of acceptance.errors) if (!failures.includes(error)) failures.push(error);
  write(`acceptance ${runFolder}/manifest.json`);
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv, strict: true, options: { script: { type: 'string' }, native: { type: 'string' }, 'when-idle': { type: 'string' }, candidate: { type: 'string' } },
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
  let prepared;
  if (values.candidate) {
    if (!candidateScripts(ROOT).includes(values.script)) throw new Error(`candidate acceptance does not declare script ${values.script}`);
    if (process.env.SOKSAK_APP || process.env.NATIVE_TEST_ONLY) throw new Error('candidate acceptance requires every candidate host and every native test');
    if (values.native !== undefined && values.native !== nativeTarget(values.script)) throw new Error('candidate acceptance native target differs from the declared tier');
    values.native = nativeTarget(values.script);
    prepared = await prepareCandidate(JSON.parse(readFileSync(values.candidate, 'utf8')), { signal: interrupt.signal });
  }
  let configRoot;
  try { configRoot = newConfigRoot(ROOT); }
  catch (error) {
    if (prepared) {
      try { await prepared.dispose(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'candidate configuration creation and reference cleanup failed'); }
    }
    throw error;
  }
  const initializationId = randomUUID();
  const runFolder = prepared ? join(ROOT, 'target', 'test-runs', `candidate-${initializationId}`) : undefined;
  write(`run ${configRoot}`);
  const inputs = {}, steps = [];
  const failures = await runPlan(e2ePlan({ root: ROOT, configRoot, script: values.script, native: values.native,
    whenIdle: values['when-idle'], candidate: prepared?.context, runFolder }),
  { write, interrupted: interrupt.signal, outcome: (value) => steps.push(value),
    capture: async (phase) => { inputs[phase] = await collectAcceptanceInputs(ROOT, prepared.context, configRoot); } });
  if (prepared) await finishCandidate({ root: ROOT, context: prepared.context, configRoot, runFolder, script: values.script,
    initializationId, inputs, steps, failures, dispose: prepared.dispose, write });
  else finishRoot(configRoot, failures, write);
  for (const failure of failures) write(`failure ${failure}`);
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

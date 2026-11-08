// Runs the end-to-end checks of core on this computer (docs/operations/examples.md#end-to-end-run):
//   node scripts/test-app.mjs --script <name> [--native <target>] [--when-idle <seconds>]
// The e2e targets of the Makefile build the three debug applications and the workspace registry, and then run this script with the
// window-check script of their tier (`verify`, `test-app:activation`, `test-app:real`, `test-app:person`) and the native end-to-end target
// of that tier. Each run makes a new configuration root under target/e2e, prepares the registry certificates and the plugins of the
// applications in it, starts the applications with that root, runs the window checks and the native end-to-end target, quits the
// applications through the quit item of the application menu and the last one through the quit key, and fails when an application
// ends with another status than 0 or when a process of the root or of an application artifact remains. The application artifacts,
// the quit, the lock release wait, the native end-to-end tests, the process list and the crash reports are platform operations
// (scripts/platform/platform.js); a platform that does not implement one fails the step with the name of that operation. A passed
// run removes its root; a failed run keeps it with the logs of the applications, so a second run starts from the same state as the
// first. Each step prints `running`, then `passed` or `failed` with its elapsed time, or `skipped` with the failed step that skipped it.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { connect } from '@soksak/client';
import { untilFolderState } from '@soksak/window-check/folder-wait.mjs';
import { applicationArtifact, applicationExecutables, crashReports, listProcesses, quitApplication as requestQuit, runNativeTests,
  waitForLockRelease } from './platform/platform.js';
import { collectAcceptanceInputs, collectOrdinaryInputs, finishAcceptanceRun, prepareCandidate, prepareOrdinaryArtifacts } from './acceptance-run.mjs';
import { CANDIDATE_HOSTS, CANDIDATE_PLATFORM, candidateScripts } from './candidate-policy.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APPS = ['wailsv3', 'tauriv2', 'mygo'];
/** The limit of a start step: the time that an application has to write endpoint.json. */
const START_LIMIT_MS = 60_000;
/** The limit of a quit step: the time that an application has to exit after its quit item or its quit key. */
const QUIT_LIMIT_MS = 60_000;

const configDir = (configRoot, app) => join(configRoot, `soksak-check-${app}`);
const nativeTarget = (script) => script === 'test-app' ? 'test-app' : script === 'test-app:activation' ? 'test-app-activation' : undefined;

/** Ordinary artifact runs use the candidate context's existing schema and installer validation, without claiming candidate acceptance. */
export function validateOrdinaryArtifacts(input, configRoot) {
  if (input?.schema !== 1 || !input.registry || !Array.isArray(input.hosts)
    || JSON.stringify(input.hosts.map(({ app }) => app).sort()) !== JSON.stringify([...APPS].sort())) {
    throw new Error('ordinary artifacts must use schema 1 and name every host exactly once');
  }
  for (const host of input.hosts) {
    if (typeof host.bundle !== 'string' || !isAbsolute(host.bundle)) throw new Error(`ordinary ${host.app} bundle must be absolute`);
  }
  if (typeof input.registry.path !== 'string' || !isAbsolute(input.registry.path)) throw new Error('ordinary registry path must be absolute');
  if (configRoot !== undefined && (!isAbsolute(configRoot) || existsSync(configRoot))) {
    throw new Error('ordinary --config-root must be an absolute new directory; existing data is never overwritten');
  }
  return input;
}

/** A new empty configuration root of one run, `<root>/target/e2e/<time>-<random>`. */
export function newConfigRoot(root) {
  const base = join(root, 'target', 'e2e');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-`));
}

/**
 * The steps of a run. A step of the phase `prepare` that fails skips every later step except those of `cleanup`; a failed `check`
 * skips nothing. `run` runs a command to its end, `start` starts an application and ends when it writes endpoint.json, `native` runs
 * the native end-to-end tests `target` of the platform, `quit` quits a started application as a person does, through the quit item of
 * its menu (`by` `menu`) or through the quit key of the platform (`by` `key`), and `remaining` fails on a process whose executable or
 * arguments name the configuration root or an application artifact. `platform` selects the platform operations, the running
 * platform when it is not given; the plan carries it to each step that runs a platform operation and carries no detail of how a
 * platform performs that operation. The plan resolves the application executables of the platform, so a platform that does not
 * implement the application artifact fails before any step starts an application.
 */
export async function e2ePlan({ root, configRoot, script, native, whenIdle, candidate, artifacts, only, runFolder, platform }) {
  if (candidate && (artifacts !== undefined || only !== undefined)) throw new Error('candidate acceptance rejects ordinary selection or artifact overrides');
  if (artifacts) validateOrdinaryArtifacts(artifacts);
  if (artifacts && !isAbsolute(configRoot)) throw new Error('ordinary configuration root must be absolute');
  const inputs = candidate ?? artifacts;
  const env = { SOKSAK_CONFIG_ROOT: configRoot };
  const ca = join(configRoot, 'soksak-check-registry-tls', 'ca.pem');
  // The declared application artifact of each application: the host entry of the context, or the debug build output of the checkout.
  const located = new Map();
  const executables = new Map();
  for (const app of APPS) {
    const artifact = inputs ? artifactOf(inputs, app) : await applicationArtifact(join(root, 'target', 'debug'), app, { platform });
    located.set(app, artifact);
    executables.set(app, await applicationExecutables(artifact, app, { platform }));
  }
  const appBinary = (app) => executables.get(app).application;
  const registry = inputs ? inputs.registry.path : join(root, 'target', 'registry', 'index.json');
  return [
    { name: 'registry certificates', phase: 'prepare', kind: 'run', argv: ['make', 'create-test-certificates'], env },
    ...(inputs ? APPS.flatMap((app) => {
      const { sok } = executables.get(app);
      const config = ['--config-dir', configDir(configRoot, app)];
      return [
        { name: `registry ${app}`, phase: 'prepare', kind: 'run', argv: [sok, 'registry', 'use', registry, ...config], env },
        ...inputs.registry.components.filter((item) => item.kind === 'plugin').map(({ id }) => ({
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
    ...(inputs ? [{ name: 'acceptance before', phase: 'prepare', kind: 'capture', capture: 'before' }] : []),
    {
      name: 'window checks', phase: 'check', kind: 'run',
      argv: ['node', 'scripts/node-tests.mjs', '--script', script, '--concurrency', '1', '--timeout', '600', ...(whenIdle === undefined ? [] : ['--when-idle', whenIdle]), ...(only === undefined ? [] : ['--only', only])],
      env: {
        ...env,
        ...Object.fromEntries(APPS.map((app) => [`SOKSAK_BINARY_${app.toUpperCase()}`, appBinary(app)])),
        SOKSAK_CANDIDATE_REGISTRY: pathToFileURL(registry).href,
        ...(candidate ? { SOKSAK_CANDIDATE_RUN_FOLDER: runFolder } : {}),
      },
    },
    ...(native === undefined ? [] : [{ name: 'native end-to-end tests', phase: 'check', kind: 'native', target: native, platform,
      env: { ...env, ...(candidate ? { SOKSAK_NATIVE_TEST_RUN_FOLDER: join(runFolder, 'native') } : {}) } }]),
    ...(inputs ? [{ name: 'acceptance after', phase: 'cleanup', kind: 'capture', capture: 'after' }] : []),
    // A person quits through the quit item of the application menu or through the quit key: each application ends by the item and the
    // last one by the key, and the run, the parent of each process, checks that it exits with status 0.
    ...APPS.map((app, index) => ({
      name: `quit ${app}`, phase: 'cleanup', kind: 'quit', by: index === APPS.length - 1 ? 'key' : 'menu', app, configDir: configDir(configRoot, app),
      platform,
    })),
    { name: 'remaining processes', phase: 'cleanup', kind: 'remaining', paths: [configRoot, ...APPS.map((app) => located.get(app))], platform },
  ];
}

/** The path of the application artifact of `app` that the host entry of a candidate or ordinary artifact context names. */
const artifactOf = (inputs, app) => inputs.hosts.find((host) => host.app === app).bundle;

/**
 * The required terminal steps use placeholder locations so the publication gate needs no workstation path, and the platform of the
 * candidate artifacts, so the gate gives the same steps on every platform that it runs on.
 */
export async function candidatePlanNames(context, script) {
  const candidate = { registry: { ...context.registry, path: '/candidate/index.json' },
    hosts: CANDIDATE_HOSTS.map((app) => ({ app, bundle: `/candidate/${app}` })) };
  const plan = await e2ePlan({ root: '/source', configRoot: '/configuration', runFolder: '/run', script,
    native: nativeTarget(script), candidate, platform: CANDIDATE_PLATFORM.platform });
  return [...plan.map(({ name }) => name), 'acceptance after cleanup', 'reference cleanup', 'configuration cleanup'];
}

/**
 * The processes of `processes`, `{pid, ppid, executable, arguments}` records, whose executable or arguments name one of the paths,
 * except the process `self`, each as `<pid> <arguments>`.
 */
export function remainingProcesses(processes, paths, self = process.pid) {
  return processes.filter(({ pid, executable, arguments: line }) => pid !== self
    && paths.some((path) => executable.includes(path) || line.includes(path))).map(({ pid, arguments: line }) => `${pid} ${line}`);
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

export async function quitApplication(item, children, since, write, connectClient = connect, lockRelease = waitForLockRelease) {
  const child = children.get(item.app);
  let client;
  let expired = false;
  const bound = limit(QUIT_LIMIT_MS, `the normal quit did not complete in ${QUIT_LIMIT_MS / 1000}s`);
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
        const selected = await requestQuit(connected, item.by, { platform: item.platform });
        if (expired) throw new Error('the normal quit deadline expired before its response');
        connected.close();
        client = undefined;
        const end = await exited(child);
        if (end.code !== 0) {
          const ended = `the application ended with ${describeExit(end)}`;
          // A platform without crash reports names that operation in the failure, which keeps the exit status.
          let reports;
          try { reports = await crashReports(item.app, since, { platform: item.platform }); }
          catch (error) { throw new Error(`${ended}; ${error.message}`); }
          for (const { report, fault } of reports) write(`crash ${report}: ${JSON.stringify(fault)}`);
          throw new Error(ended);
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
  // after relaunch. A timeout above is a failed Quit, never a forced shutdown.
  await lockReleased(item.configDir, action, item.platform, lockRelease);
}

/**
 * Waits until no process holds `<config-dir>/process.lock` (docs/spec/endpoint.md). The started process is not always the owner:
 * diagnostics.host.relaunch replaces it with a new process. The lock release wait of the platform returns when the owner exits.
 */
async function lockReleased(configDir, action, platform, lockRelease) {
  const lock = join(configDir, 'process.lock');
  if (!existsSync(lock)) return;
  if (!await lockRelease(lock, QUIT_LIMIT_MS / 1000, { platform })) {
    throw new Error(`the process that holds ${lock} did not exit in ${QUIT_LIMIT_MS / 1000}s after ${action}`);
  }
}

async function checkRemaining(item, processes) {
  const found = remainingProcesses(await processes({ platform: item.platform }), item.paths);
  if (found.length > 0) throw new Error(`${found.length} processes remain: ${found.join('; ')}`);
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
 */
export async function runPlan(steps, { write, children = new Map(), interrupted, capture, outcome = () => {}, connectClient = connect,
  lockRelease = waitForLockRelease, processes = listProcesses }) {
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
      else if (item.kind === 'quit') await quitApplication(item, children, since, write, connectClient, lockRelease);
      else if (item.kind === 'native') await runNative(item, item.phase === 'cleanup' ? undefined : interrupted);
      else if (item.kind === 'remaining') await checkRemaining(item, processes);
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
    args: argv, strict: true, options: { script: { type: 'string' }, native: { type: 'string' }, 'when-idle': { type: 'string' }, candidate: { type: 'string' },
      artifacts: { type: 'string' }, 'config-root': { type: 'string' }, only: { type: 'string' } },
  });
  if (values.script === undefined) throw new Error('--script names the window-check script of the run');
  if (values.candidate && (values.artifacts !== undefined || values.only !== undefined || values['config-root'] !== undefined)) {
    throw new Error('candidate acceptance rejects ordinary selection, artifacts and configuration overrides');
  }
  if (values['config-root'] !== undefined && values.artifacts === undefined) throw new Error('--config-root requires explicit --artifacts');
  const ordinary = values.artifacts === undefined ? undefined
    : validateOrdinaryArtifacts(JSON.parse(readFileSync(values.artifacts, 'utf8')), values['config-root']);
  if (ordinary && (process.env.SOKSAK_APP || process.env.NATIVE_TEST_ONLY)) throw new Error('ordinary artifact acceptance requires every declared host; host/native environment selection is not allowed');
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
  } else if (ordinary) {
    // Reuse the full frozen-registry/reference-install identity validation.
    // A focused ordinary run deliberately does not produce candidate acceptance.
    prepared = await prepareOrdinaryArtifacts(ordinary, { signal: interrupt.signal });
  }
  let configRoot;
  try {
    configRoot = values['config-root'];
    if (configRoot === undefined) configRoot = newConfigRoot(ROOT);
    else mkdirSync(configRoot); // Exclusive fresh root; a concurrent creator fails rather than overwrites.
  }
  catch (error) {
    if (prepared) {
      try { await prepared.dispose(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'candidate configuration creation and reference cleanup failed'); }
    }
    throw error;
  }
  const initializationId = randomUUID();
  const runFolder = values.candidate ? join(ROOT, 'target', 'test-runs', `candidate-${initializationId}`) : undefined;
  write(`run ${configRoot}`);
  const inputs = {}, steps = [];
  const failures = await runPlan(await e2ePlan({ root: ROOT, configRoot, script: values.script, native: values.native,
    whenIdle: values['when-idle'], candidate: values.candidate ? prepared?.context : undefined,
    artifacts: ordinary ? prepared.context : undefined, only: values.only, runFolder }),
  { write, interrupted: interrupt.signal, outcome: (value) => steps.push(value),
    capture: async (phase) => {
      inputs[phase] = await (values.candidate ? collectAcceptanceInputs : collectOrdinaryInputs)(ROOT, prepared.context, configRoot);
      if (ordinary) {
        write(`ordinary artifact ${phase} ${JSON.stringify(inputs[phase])}`);
        if (phase === 'after' && inputs.before) {
          const stable = ({ hosts, ...source }) => ({ ...source, hosts: hosts.map(({ pid, ...identity }) => identity) });
          if (JSON.stringify(stable(inputs.before)) !== JSON.stringify(stable(inputs.after))) throw new Error('ordinary artifact identities changed during the run');
        }
      }
    } });
  if (values.candidate) await finishCandidate({ root: ROOT, context: prepared.context, configRoot, runFolder, script: values.script,
    initializationId, inputs, steps, failures, dispose: prepared.dispose, write });
  else {
    if (prepared) {
      try { await prepared.dispose(); }
      catch (error) { failures.push(`reference cleanup: ${error.message}`); }
    }
    finishRoot(configRoot, failures, write);
  }
  for (const failure of failures) write(`failure ${failure}`);
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

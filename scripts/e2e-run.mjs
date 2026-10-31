// Runs the end-to-end checks of core on this computer (docs/operations/examples.md#end-to-end-run):
//   node scripts/e2e-run.mjs --script <name> [--native <target>] [--when-idle <seconds>]
// The e2e targets of the Makefile build both debug applications and the workspace registry, and then run this script with the
// window-check script of their tier (`verify`, `verify:activation`, `verify:real`, `verify:person`) and the native end-to-end target
// of that tier. Each run makes a new configuration root under target/e2e, prepares the registry certificates and the plugins of both
// applications in it, starts both applications with that root, runs the window checks and the native end-to-end target, quits the
// applications with host.quit and fails when a process of
// the root or of a bundle remains. A passed run removes its root; a failed run keeps it with the logs of the applications, so a second
// run starts from the same state as the first. Each step prints `running`, then `passed` or `failed` with its elapsed time, or `skipped`
// with the failed step that skipped it.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { connect } from '@soksak/client';
import { crashFault } from './crash-fault.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APPS = ['wailsv3', 'tauriv2'];
/** The limit of a start step: the time that an application has to write endpoint.json. */
const START_LIMIT_MS = 60_000;
/** The limit of a quit step: the time that an application has to exit after host.quit. */
const QUIT_LIMIT_MS = 60_000;

const bundle = (root, app) => join(root, 'target', 'debug', `soksak-${app}.app`);
const binary = (root, app) => join(bundle(root, app), 'Contents', 'MacOS', `soksak-${app}`);
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
 * started application with host.quit, and `remaining` fails on a process whose command names the configuration root or a bundle.
 */
export function e2ePlan({ root, configRoot, script, native, whenIdle }) {
  const env = { SOKSAK_CONFIG_ROOT: configRoot };
  const ca = join(configRoot, 'soksak-check-registry-tls', 'ca.pem');
  return [
    { name: 'registry certificates', phase: 'prepare', kind: 'run', argv: ['make', 'e2e-registry-tls'], env },
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
        SOKSAK_BINARY_WAILSV3: binary(root, 'wailsv3'),
        SOKSAK_BINARY_TAURIV2: binary(root, 'tauriv2'),
        SOKSAK_CANDIDATE_REGISTRY: pathToFileURL(join(root, 'target', 'registry', 'index.json')).href,
      },
    },
    ...(native === undefined ? [] : [{ name: 'native end-to-end tests', phase: 'check', kind: 'run', argv: ['make', '-C', 'native/darwin', native], env }]),
    ...APPS.map((app) => ({ name: `quit ${app}`, phase: 'cleanup', kind: 'quit', app, configDir: configDir(configRoot, app) })),
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

async function runCommand(item) {
  const child = spawn(item.argv[0], item.argv.slice(1), { cwd: ROOT, env: { ...process.env, ...item.env }, stdio: 'inherit' });
  const [result] = await Promise.race([
    exited(child).then((end) => [end]),
    once(child, 'error').then(([error]) => { throw new Error(`cannot start ${item.argv[0]}: ${error.message}`); }),
  ]);
  if (result.code !== 0) throw new Error(`exited with ${describeExit(result)}`);
}

/**
 * Starts an application and resolves when its configuration folder holds endpoint.json. The folder is watched for the file
 * (fs.watch), and the file is looked for once after the watch starts, so a file written before the watch is found too.
 */
async function startApplication(item, children) {
  mkdirSync(item.configDir, { recursive: true });
  const endpoint = join(item.configDir, 'endpoint.json');
  const output = openSync(item.output, 'a');
  const child = spawn(item.argv[0], item.argv.slice(1), { cwd: ROOT, stdio: ['ignore', output, output] });
  children.set(item.app, child);
  const watcher = watch(item.configDir);
  const bound = limit(START_LIMIT_MS, `the application wrote no endpoint.json in ${START_LIMIT_MS / 1000}s`);
  try {
    await Promise.race([
      new Promise((resolve) => {
        watcher.on('change', () => { if (existsSync(endpoint)) resolve(); });
        if (existsSync(endpoint)) resolve();
      }),
      once(watcher, 'error').then(([error]) => { throw new Error(`cannot watch ${item.configDir}: ${error.message}`); }),
      once(child, 'error').then(([error]) => { throw new Error(`cannot start ${item.argv[0]}: ${error.message}`); }),
      exited(child).then((end) => { throw new Error(`the application exited with ${describeExit(end)} before it wrote endpoint.json`); }),
      bound.promise,
    ]);
  } finally {
    bound.clear();
    watcher.close();
  }
}

/** The crash reports of the application that the system wrote since `since` (ms), each with the fault that names its address. */
function crashReports(app, since) {
  const folder = join(homedir(), 'Library', 'Logs', 'DiagnosticReports');
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.startsWith(`soksak-${app}-`) && name.endsWith('.ips'))
    .map((name) => join(folder, name))
    .filter((file) => statSync(file).mtimeMs >= since)
    .map((file) => `${file}: ${JSON.stringify(crashFault(readFileSync(file, 'utf8'), file))}`);
}

async function quitApplication(item, children, since, write) {
  const child = children.get(item.app);
  const client = await connect({ configDir: item.configDir });
  try {
    const reply = await client.request('command.run', { window: 'main', name: 'host.quit', params: {} });
    if (reply !== null) throw new Error(`host.quit returned ${JSON.stringify(reply)}, expected null`);
  } finally {
    client.close();
  }
  const bound = limit(QUIT_LIMIT_MS, `the application did not exit in ${QUIT_LIMIT_MS / 1000}s after host.quit`);
  let end;
  try {
    end = await Promise.race([exited(child), bound.promise]);
  } finally {
    bound.clear();
  }
  if (end.code === 0) return;
  for (const line of crashReports(item.app, since)) write(`crash ${line}`);
  throw new Error(`the application ended with ${describeExit(end)}`);
}

function checkRemaining(item) {
  const found = remainingProcesses(execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 }), item.paths);
  if (found.length > 0) throw new Error(`${found.length} processes remain: ${found.join('; ')}`);
}

/**
 * Runs the steps in order and returns the failures as `<step>: <reason>`. `children` holds the started applications by name, so a quit
 * step reaches the application of an earlier start step.
 */
export async function runPlan(steps, { write, children = new Map() }) {
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
    write(`running ${item.name}`);
    const from = performance.now();
    try {
      if (item.kind === 'run') await runCommand(item);
      else if (item.kind === 'start') await startApplication(item, children);
      else if (item.kind === 'quit') await quitApplication(item, children, since, write);
      else if (item.kind === 'remaining') checkRemaining(item);
      else throw new Error(`unknown step kind ${JSON.stringify(item.kind)}`);
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
  const failures = await runPlan(e2ePlan({ root: ROOT, configRoot, script: values.script, native: values.native, whenIdle: values['when-idle'] }), { write });
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

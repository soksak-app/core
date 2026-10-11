// Runs the Node test files of the workspace as processes of their own through the test runner, so each file is named when it
// starts and ends with its elapsed time, has its own limit, and runs in parallel (docs/operations/examples.md#test-runner).
// The test script of each package names the flags and the paths: `node --test [flags] <paths>`, optionally after commands such as
// `pnpm build`. `--script <name>` reads another script of the packages that have it (`verify` runs the window checks, with
// `--concurrency 1` because they share the applications, and `--timeout <seconds>`, at most 600, and `--when-idle <seconds>` starts a file only after the person gave no input for that long, so the checks do not take the focus of the person). The files are those that `node --test` runs for the paths: a directory holds every JavaScript file under it.
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRunWithCatalog } from './audit-run.mjs';
import { runTests } from './test-runner.mjs';

/** The seconds since the last keyboard or pointer input of the person, or null when the system does not report it. */
export function idleSeconds() {
  const text = execFileSync('ioreg', ['-c', 'IOHIDSystem'], { encoding: 'utf8', maxBuffer: 1 << 24 });
  const match = /"HIDIdleTime" = (\d+)/.exec(text);
  return match === null ? null : Number(match[1]) / 1e9;
}

/**
 * A gate that opens when the person has been idle for `seconds`. The system reports no event for the end of an input, so the gate
 * reads the idle time every `intervalMs` (docs/operations/examples.md#test-runner).
 */
export function whenIdle(seconds, { idle = idleSeconds, intervalMs = 5000, write = () => {} } = {}) {
  return async (item) => {
    for (;;) {
      const value = idle();
      if (value === null) throw new Error('the system does not report the idle time of the input');
      if (value >= seconds) return;
      write(`WAIT ${item.name}: the person was active ${value.toFixed(0)}s ago, waiting for ${seconds}s without input`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The identifier and the folder of a run: the start time to the second and the process id, under `target/test-runs`. */
export function newRun(root, now = new Date()) {
  const id = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}-${process.pid}`;
  return { id, folder: join(root, 'target', 'test-runs', id) };
}
/** The limit of one test file. */
const TEST_TIMEOUT_MS = 120_000;
const SOURCE = /\.(?:[cm]?js)$/;

/**
 * The steps of a test script: the commands to run before the tests (`before`), and the flags and paths of `node --test`. The step
 * `pnpm -r test` runs the tests of the packages, which this runner discovers itself, so it is not a step.
 */
export function parseTestScript(script, where) {
  const steps = script.split('&&').map((step) => step.trim());
  const before = [];
  let tests = null;
  for (const step of steps) {
    if (step.startsWith('node --test ')) {
      if (tests !== null) throw new Error(`${where}: the test script "${script}" runs node --test twice`);
      const words = step.slice('node --test '.length).split(/\s+/).filter(Boolean).map((word) => word.replace(/^'(.*)'$/, '$1'));
      tests = { flags: words.filter((word) => word.startsWith('--')), paths: words.filter((word) => !word.startsWith('--')) };
    } else if (step === 'pnpm -r test') {
      continue;
    } else if (step.startsWith('pnpm ')) {
      before.push(step);
    } else if (tests === null && before.length === 0 && steps.length === 1) {
      throw new Error(`${where}: the test script "${script}" is not node --test`);
    } else {
      throw new Error(`${where}: the test script step "${step}" is not node --test or pnpm`);
    }
  }
  if (tests === null || tests.paths.length === 0) throw new Error(`${where}: the test script "${script}" is not node --test with a path`);
  return { before, ...tests };
}

/** The JavaScript files under a directory, in path order. */
function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() && SOURCE.test(entry.name) ? [path] : [];
  });
}

/** The files that one path of a test script names: a glob, a file or a directory. */
function filesOf(folder, path) {
  if (path.includes('*')) return globSync(path, { cwd: folder }).map((file) => join(folder, file));
  const full = join(folder, path);
  if (!existsSync(full)) return [];
  return statSync(full).isDirectory() ? filesUnder(full) : [full];
}

/**
 * The tests of the packages (folders relative to `root`, or `.` for the root): one test per file, with the folder of its package
 * and the flags of its script, and the commands to run before them.
 */
export function discoverNodeTests({ root, packages, script: scriptName = 'test' }) {
  const tests = [];
  const before = [];
  for (const folder of packages) {
    const directory = join(root, folder);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    // The test script of the root runs this runner, so the root names the files of its own scripts in `test:scripts`.
    const key = folder === '.' && scriptName === 'test' ? 'test:scripts' : scriptName;
    if (manifest.scripts?.[key] === undefined) continue;
    const script = parseTestScript(manifest.scripts[key], folder);
    for (const step of script.before) {
      const [command, ...args] = step.split(/\s+/);
      before.push({ name: `${folder}: ${step}`, command, args, cwd: directory });
    }
    const files = [...new Set(script.paths.flatMap((path) => filesOf(directory, path)))].sort();
    if (files.length === 0) throw new Error(`${folder}: the test script names no test file in ${script.paths.join(' ')}`);
    for (const file of files) {
      tests.push({ name: relative(root, file).split('\\').join('/'), command: process.execPath, args: ['--test', ...script.flags, file], cwd: directory });
    }
  }
  return { tests, before };
}

/** The folders of the workspace packages relative to the root, the root first. */
function workspacePackages(root) {
  const listed = JSON.parse(execFileSync('pnpm', ['-r', 'list', '--json', '--depth', '-1'], { cwd: root, encoding: 'utf8' }));
  return listed.map((item) => relative(root, item.path) || '.').sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)));
}

/**
 * The audit of the logs that follows a run of window checks (`--script verify`) or of the activation tier
 * (`--script verify:activation`): `audit(run folder)` returns the findings `<file>:<line>: <message>`, which are written, and the
 * status is 1 when there is one or when the audit cannot run (for example, the run left no marks). Other scripts leave no logs.
 */
export function auditAfterRun(scriptName, run, write, audit = auditRunWithCatalog) {
  if (scriptName !== 'verify' && !scriptName.startsWith('verify:')) return 0;
  let findings;
  try {
    findings = audit(run.folder);
  } catch (error) {
    write(`AUDIT FAIL ${error.message}`);
    return 1;
  }
  for (const finding of findings) write(`AUDIT ${finding}`);
  write(findings.length === 0 ? `AUDIT PASS the logs of run ${run.id}` : `AUDIT FAIL ${findings.length} findings in the logs of run ${run.id}`);
  return findings.length === 0 ? 0 : 1;
}

async function main(argv) {
  const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const only = option('--only', '');
  const scriptName = option('--script', 'test');
  const limitMs = Number(option('--timeout', TEST_TIMEOUT_MS / 1000)) * 1000;
  const write = (line) => process.stdout.write(`${line}\n`);
  const { tests: all, before } = discoverNodeTests({ root: ROOT, packages: workspacePackages(ROOT), script: scriptName });
  const tests = all.filter((item) => item.name.includes(only));
  if (tests.length === 0) throw new Error(`no test file contains ${JSON.stringify(only)}`);
  // The commands before the tests run one at a time, each with its elapsed time, and a failure ends the run.
  const prepare = before.filter((step) => tests.some((item) => item.cwd === step.cwd));
  if (prepare.length > 0) {
    const built = await runTests({ tests: prepare, concurrency: 1, defaultTimeoutMs: 300_000, write });
    if ([...built.results.values()].some((result) => result.status !== 'pass')) return 1;
  }
  const concurrency = Number(option('--concurrency', Math.max(2, cpus().length - 2)));
  const run = newRun(ROOT);
  write(`RUN  ${tests.length} test files with ${concurrency} at once, each limited to ${limitMs / 1000}s; run ${run.id} keeps its output and manifest in ${run.folder}`);
  const idle = option('--when-idle', null);
  const beforeEach = idle === null ? undefined : whenIdle(Number(idle), { write });
  const { results } = await runTests({ tests, concurrency, defaultTimeoutMs: limitMs, write, beforeEach, run });
  const passed = [...results.values()].every((result) => result.status === 'pass');
  // The logs are audited also when a test failed, because a failed run is classified by its logs.
  const audited = auditAfterRun(scriptName, run, write);
  return passed && audited === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

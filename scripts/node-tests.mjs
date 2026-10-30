// Runs the Node test files of the workspace as processes of their own through the test runner, so each file is named when it
// starts and ends with its elapsed time, has its own limit, and runs in parallel (docs/operations/examples.md#test-runner).
// The test script of each package names the flags and the paths: `node --test [flags] <paths>`, optionally after commands such as
// `pnpm build`. `--script <name>` reads another script of the packages that have it (`verify` runs the window checks, with
// `--concurrency 1` because they share the applications, and `--timeout <seconds>`, at most 600, which is the limit of each test that declares none, and `--when-idle <seconds>` starts a file only after the person gave no input for that long, so the checks do not take the focus of the person). A file has no limit of its own. The files are those that `node --test` runs for the paths: a directory holds every JavaScript file under it. `--changed <range>` selects only the packages that hold a file which `git diff --name-only <range>` lists or declare it in `specFiles` of their package.json; `make push-check` runs the tests of the changed packages with it.
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRunWithCatalog } from './audit-run.mjs';
import { MAX_TEST_TIMEOUT_MS, runTests } from './test-runner.mjs';

/** The seconds since the last keyboard or pointer input of the person, or null when the system does not report it. */
export function idleSeconds() {
  const text = execFileSync('ioreg', ['-c', 'IOHIDSystem'], { encoding: 'utf8', maxBuffer: 1 << 24 });
  const match = /"HIDIdleTime" = (\d+)/.exec(text);
  return match === null ? null : Number(match[1]) / 1e9;
}

/**
 * A gate that opens when the person has been idle for `seconds`. No examined event source serves without a permission that an unattended run cannot grant, so the
 * gate reads the idle time every `intervalMs` (docs/operations/examples.md#test-runner).
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
/** The default limit of each test of a test file, which node --test applies to the tests that declare no timeout. */
const TEST_TIMEOUT_MS = 120_000;
/**
 * The exit limit of a test file process after its tests ended (`test:summary`). The files of scripts/test, run 8 at once, exited at most
 * 155 ms after the summary of their tests (12 ms at the median), so 20 s is more than 100 times the longest measured exit, and a process
 * that does not exit within it waits in its shutdown instead of ending under load.
 */
const EXIT_LIMIT_MS = 20_000;
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
    if (step.startsWith('node --test ') || step.startsWith('node ./run.mjs --test ')) {
      if (tests !== null) throw new Error(`${where}: the test script "${script}" runs node --test twice`);
      const command = step.startsWith('node ./run.mjs --test ')
        ? step.slice('node ./run.mjs --test '.length)
        : step.slice('node --test '.length);
      const words = command.split(/\s+/).filter(Boolean).map((word) => word.replace(/^'(.*)'$/, '$1'));
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

/** The reporters of a test file: the spec form on the standard output and the TAP form on the standard error. */
// The event reporter writes one line per test event to the standard error, which the runner reads for the event watchdog of the file.
const EVENT_REPORTER = fileURLToPath(new URL('./test-event-reporter.mjs', import.meta.url));
const REPORTERS = ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', '--test-reporter-destination=stderr',
  `--test-reporter=${EVENT_REPORTER}`, '--test-reporter-destination=stderr'];

/**
 * The specification files that the sources of a package read, which its manifest declares in `specFiles` (paths under
 * `docs/spec/`; a path that ends in `/` names a folder). `make boundaries` fails when a source reads a file of docs/spec that its
 * package does not declare, so the declaration is complete.
 */
export function specFilesOf(manifest, where) {
  const declared = manifest.specFiles ?? [];
  if (!Array.isArray(declared) || declared.some((path) => typeof path !== 'string' || !path.startsWith('docs/spec/') || path.includes('..'))) {
    throw new Error(`${where}: specFiles must be a list of paths under docs/spec/, found ${JSON.stringify(declared)}`);
  }
  return declared;
}

/** Whether a declared path of `specFiles` names the file: the same file, or a folder that holds it. */
export function declaresFile(declared, file) {
  return declared.endsWith('/') ? file.startsWith(declared) : file === declared;
}

/**
 * The packages that hold the changed files (paths relative to the root), and the packages whose `specFiles` (`specFiles(folder)`)
 * names a changed file. A file belongs to the deepest package folder that contains it; a file that no package folder contains
 * belongs to the root `.`. The result keeps the order of `packages`.
 */
export function changedPackages(files, packages, specFiles = () => []) {
  const owned = new Set();
  for (const file of files) {
    let owner = null;
    for (const folder of packages) {
      if (folder !== '.' && file.startsWith(`${folder}/`) && (owner === null || folder.length > owner.length)) owner = folder;
    }
    owned.add(owner ?? '.');
  }
  return packages.filter((folder) => owned.has(folder)
    || specFiles(folder).some((declared) => files.some((file) => declaresFile(declared, file))));
}

/** Selects test files by the existing substring selector and explicit root-relative path exclusions. */
export function selectNodeTests(tests, { only = '', exclude = [] } = {}) {
  const prefixes = exclude.map((path) => {
    if (typeof path !== 'string') throw new Error(`--exclude path must be a nonempty root-relative path, found ${JSON.stringify(path)}`);
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    const segments = normalized.split('/');
    if (normalized.length === 0 || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
        || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
      throw new Error(`--exclude path must be a nonempty root-relative path, found ${JSON.stringify(path)}`);
    }
    return normalized;
  });
  return tests.filter((item) => item.name.includes(only)
    && !prefixes.some((prefix) => item.name === prefix || item.name.startsWith(`${prefix}/`)));
}

/**
 * The tests of the packages (folders relative to `root`, or `.` for the root): one test per file, with the folder of its package
 * and the flags of its script, and the commands to run before them. With `changed` (the changed files), only the packages that hold
 * a changed file or declare it in `specFiles` are discovered. `testTimeoutMs` is the limit of each test that declares none (`--test-timeout`).
 */
export function discoverNodeTests({ root, packages, script: scriptName = 'test', changed, testTimeoutMs = TEST_TIMEOUT_MS }) {
  const tests = [];
  const before = [];
  const manifests = new Map(packages.map((folder) => [folder, JSON.parse(readFileSync(join(root, folder, 'package.json'), 'utf8'))]));
  const selected = changed === undefined ? packages
    : changedPackages(changed, packages, (folder) => specFilesOf(manifests.get(folder), `${folder === '.' ? '' : `${folder}/`}package.json`));
  for (const folder of selected) {
    const directory = join(root, folder);
    const manifest = manifests.get(folder);
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
      // The spec reporter writes the errors of the failed tests at the end of the file, so a file that is killed keeps none;
      // the TAP reporter on the standard error writes the error of each test when the test ends. --test-force-exit ends the file
      // process when its tests end, so a test that timed out with an open handle does not keep the file running. The event watchdog
      // of the file is the largest limit of a test: a file whose events stop for that long holds a test that its own limit did not end.
      // The exit limit ends a file process that does not exit after the summary of its tests, when no test runs.
      tests.push({ name: relative(root, file).split('\\').join('/'), command: process.execPath,
        args: ['--test', ...REPORTERS, `--test-timeout=${testTimeoutMs}`, '--test-force-exit', ...script.flags, file], cwd: directory,
        eventLimitMs: MAX_TEST_TIMEOUT_MS, exitLimitMs: EXIT_LIMIT_MS });
    }
  }
  return { tests, before };
}

/** The folders of the workspace packages relative to the root, the root first. */
export function workspacePackages(root) {
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
  write(findings.length === 0 ? `AUDIT PASS the logs of run ${run.id}` : `AUDIT FAIL ${findings.length} findings in the logs of run ${run.id}; the judgment of each test is ${run.folder}/judgment.json`);
  return findings.length === 0 ? 0 : 1;
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv, strict: true,
    options: {
      only: { type: 'string', default: '' },
      exclude: { type: 'string', multiple: true, default: [] },
      script: { type: 'string', default: 'test' },
      timeout: { type: 'string', default: String(TEST_TIMEOUT_MS / 1000) },
      concurrency: { type: 'string', default: String(Math.max(2, cpus().length - 2)) },
      'when-idle': { type: 'string' },
      changed: { type: 'string' },
    },
  });
  const count = (name) => {
    const number = Number(values[name]);
    if (!Number.isFinite(number) || number <= 0) throw new Error(`--${name} must be a positive number, found ${JSON.stringify(values[name])}`);
    return number;
  };
  const only = values.only;
  const scriptName = values.script;
  const limitMs = count('timeout') * 1000;
  if (limitMs > MAX_TEST_TIMEOUT_MS) throw new Error(`--timeout must be at most ${MAX_TEST_TIMEOUT_MS / 1000} seconds, found ${values.timeout}`);
  const write = (line) => process.stdout.write(`${line}\n`);
  // With --changed, the files that the revision range changes select the packages that hold them or declare them in specFiles.
  const changed = values.changed === undefined ? undefined
    : execFileSync('git', ['diff', '--name-only', values.changed], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const { tests: all, before } = discoverNodeTests({ root: ROOT, packages: workspacePackages(ROOT), script: scriptName, changed, testTimeoutMs: limitMs });
  if (changed !== undefined && all.length === 0) {
    write(`SKIP no test file of a package changed in ${values.changed}`);
    return 0;
  }
  const tests = selectNodeTests(all, { only, exclude: values.exclude });
  if (tests.length === 0) throw new Error(`no test file contains ${JSON.stringify(only)}`);
  // The commands before the tests run one at a time, each with its elapsed time, and a failure ends the run.
  const prepare = before.filter((step) => tests.some((item) => item.cwd === step.cwd));
  if (prepare.length > 0) {
    const built = await runTests({ tests: prepare.map((step) => ({ ...step, timeoutMs: 300_000 })), concurrency: 1, write });
    if ([...built.results.values()].some((result) => result.status !== 'pass')) return 1;
  }
  const concurrency = count('concurrency');
  const run = newRun(ROOT);
  write(`RUN  ${tests.length} test files with ${concurrency} at once, each test limited to ${limitMs / 1000}s and no limit for a file; run ${run.id} keeps its output and manifest in ${run.folder}`);
  const beforeEach = values['when-idle'] === undefined ? undefined : whenIdle(count('when-idle'), { write });
  const { results } = await runTests({ tests, concurrency, write, beforeEach, run });
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

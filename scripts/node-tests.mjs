// Runs the Node test files of the workspace as processes of their own through the test runner, so each file is named when it
// starts and ends with its elapsed time, has its own limit, and runs in parallel (docs/operations/examples.md#test-runner).
// The test script of each package names the flags and the paths: `node --test [flags] <paths>`, optionally after commands such as
// `pnpm build`. The files are those that `node --test` runs for the paths: a directory holds every JavaScript file under it.
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from './test-runner.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
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
      const words = step.slice('node --test '.length).split(/\s+/).filter(Boolean);
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
export function discoverNodeTests({ root, packages }) {
  const tests = [];
  const before = [];
  for (const folder of packages) {
    const directory = join(root, folder);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    // The test script of the root runs this runner, so the root names the files of its own scripts in `test:scripts`.
    const key = folder === '.' ? 'test:scripts' : 'test';
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

async function main(argv) {
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '';
  const write = (line) => process.stdout.write(`${line}\n`);
  const { tests: all, before } = discoverNodeTests({ root: ROOT, packages: workspacePackages(ROOT) });
  const tests = all.filter((item) => item.name.includes(only));
  if (tests.length === 0) throw new Error(`no test file contains ${JSON.stringify(only)}`);
  // The commands before the tests run one at a time, each with its elapsed time, and a failure ends the run.
  const prepare = before.filter((step) => tests.some((item) => item.cwd === step.cwd));
  if (prepare.length > 0) {
    const built = await runTests({ tests: prepare, concurrency: 1, defaultTimeoutMs: 300_000, write });
    if ([...built.results.values()].some((result) => result.status !== 'pass')) return 1;
  }
  const concurrency = Math.max(2, cpus().length - 2);
  write(`RUN  ${tests.length} test files with ${concurrency} at once, each limited to ${TEST_TIMEOUT_MS / 1000}s`);
  const { results } = await runTests({ tests, concurrency, defaultTimeoutMs: TEST_TIMEOUT_MS, write });
  return [...results.values()].every((result) => result.status === 'pass') ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

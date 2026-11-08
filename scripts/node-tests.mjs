// Runs the Node test files of the workspace as processes of their own through the test runner, so each file is named when it
// starts and ends with its elapsed time, has its own limit, and runs in parallel (docs/operations/examples.md#test-parity).
// The test script of each package names the flags and the paths: `node --test [flags] <paths>`, optionally after commands such as
// `pnpm build`. `--script <name>` reads another script of the packages that have it (`verify` runs the window checks, with
// `--concurrency 1` because they share the applications, and `--timeout <seconds>`, at most 600, which is the limit of each test that declares none, and `--when-idle <seconds>` starts a file only after the person gave no input for that long, so the checks do not take the focus of the person). A file has no limit of its own. The words of the script keep the spaces of their quoted parts and lose their quotes, as the shell of a package script reads them. The files are those that `node --test` runs for the paths: a directory holds every JavaScript file under it, and a path that names no file is an error. `--changed <range>` selects only the packages that hold a file which `git diff --name-only <range>` lists or declare it in `specFiles` of their package.json.
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShell, stringifyCommand } from '@yarnpkg/parsers';
import { auditRunWithCatalog } from './audit-run.mjs';
import { MAX_TEST_TIMEOUT_MS, runTests } from './test-runner.mjs';
import { NODE_TEST_REPORTERS } from './node-test-evidence.mjs';
import { CANDIDATE_HOSTS, candidateScripts } from './candidate-policy.mjs';

/** The seconds since the last keyboard or pointer input of the person, or null when the system does not report it. */
export function idleSeconds() {
  const text = execFileSync('ioreg', ['-c', 'IOHIDSystem'], { encoding: 'utf8', maxBuffer: 1 << 24 });
  const match = /"HIDIdleTime" = (\d+)/.exec(text);
  return match === null ? null : Number(match[1]) / 1e9;
}

/**
 * A gate that opens when the person has been idle for `seconds`. No examined event source serves without a permission that an unattended run cannot grant, so the
 * gate reads the idle time every `intervalMs` (docs/operations/examples.md#test-parity).
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

// These Node test options take a separate value as well as --name=value. Other long options retain their
// declared form and Node validates them; an undeclared separate value is a path and must resolve to a file.
const NODE_VALUE_OPTIONS = Object.fromEntries([
  'test-name-pattern', 'test-skip-pattern', 'test-concurrency', 'test-timeout', 'test-global-setup',
  'test-shard', 'test-isolation', 'test-reporter', 'test-reporter-destination',
].map((name) => [name, { type: 'string', multiple: true }]));

/**
 * The literal commands of a test script separated by &&, parsed without evaluating any shell input: a quoted part keeps its spaces
 * and loses its quotes (`--flag="a b"` is `--flag=a b`), and any other shell syntax is an error that names the script or the step.
 */
function scriptSteps(script, where) {
  let parsed;
  try {
    parsed = parseShell(script);
  } catch (error) {
    throw new Error(`${where}: the test script "${script}" has invalid syntax: ${error.message}`, { cause: error });
  }
  const unsupported = () => new Error(`${where}: the test script supports only literal commands joined by &&`);
  if (parsed.length !== 1 || parsed[0].type !== ';') throw unsupported();
  const steps = [];
  for (let line = parsed[0].command; line; line = line.then?.line) {
    const { chain } = line;
    if ((line.then && line.then.type !== '&&') || chain.type !== 'command' || chain.envs.length || chain.then) throw unsupported();
    const words = chain.args.map((arg) => {
      if (arg.type !== 'argument' || arg.segments.some((segment) => segment.type !== 'text')) throw unsupported();
      const word = arg.segments.map((segment) => segment.text).join('');
      // Yarn treats backticks as text, so refuse them rather than reinterpret a shell substitution as a literal pattern.
      if (word.includes('`')) throw unsupported();
      return word;
    });
    steps.push({ name: stringifyCommand(chain), words });
  }
  return steps;
}

/**
 * The steps of a test script: the commands to run before the tests (`before`, each with its name, command and arguments), and the flags and paths of
 * `node --test`. The step `pnpm -r test` runs the tests of the packages, which this runner discovers itself, so it is not a step.
 */
export function parseTestScript(script, where) {
  const steps = scriptSteps(script, where);
  const before = [];
  let tests = null;
  for (const [index, { name: step, words }] of steps.entries()) {
    const prefix = words[0] === 'node' && words[1] === '--test' ? 2
      : words[0] === 'node' && words[1] === './run.mjs' && words[2] === '--test' ? 3 : 0;
    if (prefix) {
      if (tests !== null) throw new Error(`${where}: the test script "${script}" runs node --test twice`);
      const args = words.slice(prefix);
      const { tokens, positionals } = parseArgs({ args, options: NODE_VALUE_OPTIONS, allowPositionals: true, strict: false, tokens: true });
      const flags = [];
      for (const token of tokens) {
        if (token.kind === 'positional') continue;
        if (token.kind === 'option-terminator') { flags.push('--'); continue; }
        if (!token.rawName.startsWith('--')) throw new Error(`${where}: unsupported Node test option ${token.rawName}`);
        if (NODE_VALUE_OPTIONS[token.name] && (token.value === undefined || (!token.inlineValue && token.value.startsWith('--')))) {
          throw new Error(`${where}: ${token.rawName} requires a value`);
        }
        flags.push(args[token.index]);
        if (token.value !== undefined && !token.inlineValue) flags.push(args[token.index + 1]);
      }
      tests = { flags, paths: positionals };
    } else if (words.length === 3 && words[0] === 'pnpm' && words[1] === '-r' && words[2] === 'test') {
      if (tests === null || index !== steps.length - 1) throw new Error(`${where}: pnpm -r test is supported only after the Node tests`);
      continue;
    } else if (words[0] === 'pnpm' && words.length > 1 && tests === null) {
      before.push({ name: step, command: words[0], args: words.slice(1) });
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

/**
 * The files that one path of a test script names: a glob, a file or a directory. A path that names no file is an error that names the
 * path and the package folder (`where`), because node --test would read the path as nothing and the run would pass without its tests.
 */
function filesOf(folder, path, where) {
  const full = join(folder, path);
  const files = path === '' ? [] : path.includes('*') ? globSync(path, { cwd: folder }).map((file) => join(folder, file))
    : !existsSync(full) ? [] : statSync(full).isDirectory() ? filesUnder(full) : [full];
  if (files.length === 0) throw new Error(`${where}: the test script path ${path} names no file in the package folder ${where}`);
  return files;
}

/**
 * The specification files that the sources of a package read, which its manifest declares in `specFiles` (paths under
 * `docs/spec/`; a path that ends in `/` names a folder). `make check-boundaries` fails when a source reads a file of docs/spec that its
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

/** The substrings of `--only`: one string (empty for none) or the list of a repeated option. */
function onlyList(only) {
  return (Array.isArray(only) ? only : [only]).filter((value) => value !== '');
}

/** A nonempty relative path without `.` or `..` segments, normalized to forward slashes and no trailing slash. */
function relativePath(path, option) {
  const message = `${option} path must be a nonempty root-relative path, found ${JSON.stringify(path)}`;
  if (typeof path !== 'string') throw new Error(message);
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/');
  if (normalized.length === 0 || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
      || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(message);
  }
  return normalized;
}

/**
 * Selects test files by the substring selector, which a repeated `--only` widens to the files that contain any of its values,
 * explicit root-relative path exclusions, and `excludeFolder`: relative folder paths such as `platform/darwin/system` whose files
 * are excluded under any folder of the workspace.
 */
export function selectNodeTests(tests, { only = '', exclude = [], excludeFolder = [] } = {}) {
  const onlies = onlyList(only);
  const prefixes = exclude.map((path) => relativePath(path, '--exclude'));
  const folders = excludeFolder.map((path) => relativePath(path, '--exclude-folder'));
  return tests.filter((item) => (onlies.length === 0 || onlies.some((value) => item.name.includes(value)))
    && !prefixes.some((prefix) => item.name === prefix || item.name.startsWith(`${prefix}/`))
    && !folders.some((folder) => item.name.startsWith(`${folder}/`) || item.name.includes(`/${folder}/`)));
}

/**
 * The tests to run, or the reason to run none: with `range` (a --changed revision range) a selection that is empty after
 * `only` and `exclude` runs no test, because the range changed no test file that the run owns; without a range it is an error.
 */
export function planNodeRun(all, { range, only = '', exclude = [], excludeFolder = [] } = {}) {
  const tests = selectNodeTests(all, { only, exclude, excludeFolder });
  if (tests.length > 0) return { tests };
  const onlies = onlyList(only);
  if (range === undefined) throw new Error(`no test file contains ${onlies.length === 0 ? '""' : onlies.map((value) => JSON.stringify(value)).join(' or ')}`);
  const after = all.length === 0 ? '' : ` remains after ${[...exclude.map((path) => `--exclude ${path}`), ...excludeFolder.map((path) => `--exclude-folder ${path}`)].join(' ')}${onlies.map((value) => ` --only ${value}`).join('')}`;
  return { skip: `SKIP no test file of a package changed in ${range}${after}` };
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
      before.push({ ...step, name: `${folder}: ${step.name}`, cwd: directory });
    }
    const files = [...new Set(script.paths.flatMap((path) => filesOf(directory, path, folder)))].sort();
    for (const file of files) {
      // The TAP reporter on the standard output writes the error of each test when the test ends, so a file that is killed keeps the
      // errors of the tests that failed before. The file process ends by itself when
      // its tests end and is not ended with process.exit: on macOS the pipes of the standard output and error are asynchronous, and
      // process.exit drops the reports still queued on them (the last reports of a file were lost that way). The event watchdog
      // of the file is the largest limit of a test: a file whose events stop for that long holds a test that its own limit did not end.
      // The exit limit ends a file process that does not exit after the summary of its tests, when no test runs, and names its samples.
      tests.push({ name: relative(root, file).split('\\').join('/'), command: process.execPath,
        args: ['--test', ...NODE_TEST_REPORTERS, `--test-timeout=${testTimeoutMs}`, ...script.flags, file], cwd: directory,
        eventLimitMs: MAX_TEST_TIMEOUT_MS, exitLimitMs: EXIT_LIMIT_MS, nodeTestFile: file });
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
 * The audit of the logs that follows a run of window checks (`--script test-app`) or of the activation tier
 * (`--script test-app:activation`): `audit(run folder)` returns the findings `<file>:<line>: <message>`, which are written, and the
 * status is 1 when there is one or when the audit cannot run (for example, the run left no marks). Other scripts leave no logs.
 */
export function auditAfterRun(scriptName, run, write, audit = auditRunWithCatalog) {
  if (scriptName !== 'test-app' && !scriptName.startsWith('test-app:') && !scriptName.startsWith('benchmark:')) return 0;
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

/** A candidate run is the complete declared script on every candidate host, without an inherited selection. */
export function candidateSelection(values, tests, env = process.env) {
  if (onlyList(values.only ?? '').length || values.exclude?.length || values['exclude-folder']?.length || values.changed !== undefined || env.SOKSAK_APP || env.NATIVE_TEST_ONLY
    || /--test-(?:name-pattern|skip-pattern|only|shard)\b/.test(env.NODE_OPTIONS ?? '')
    || tests.some(({ args }) => args.some((arg) => /^--test-(?:name-pattern|skip-pattern|only|shard)(?:=|$)/.test(arg)))) {
    throw new Error('candidate acceptance requires the complete declared script and every candidate host without test selection');
  }
  return { only: null, exclude: [], changed: false, namePattern: null, apps: [...CANDIDATE_HOSTS] };
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv, strict: true,
    options: {
      only: { type: 'string', multiple: true, default: [] },
      exclude: { type: 'string', multiple: true, default: [] },
      'exclude-folder': { type: 'string', multiple: true, default: [] },
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
  const candidateFolder = process.env.SOKSAK_CANDIDATE_RUN_FOLDER;
  const selection = candidateFolder ? candidateSelection(values, all) : null;
  if (candidateFolder && !candidateScripts(ROOT).includes(scriptName)) throw new Error(`candidate acceptance does not declare script ${scriptName}`);
  const plan = planNodeRun(all, { range: values.changed, only, exclude: values.exclude, excludeFolder: values['exclude-folder'] });
  if (plan.skip !== undefined) {
    write(plan.skip);
    return 0;
  }
  const { tests } = plan;
  // The commands before the tests run one at a time, each with its elapsed time, and a failure ends the run.
  const prepare = before.filter((step) => tests.some((item) => item.cwd === step.cwd));
  if (prepare.length > 0) {
    const built = await runTests({ tests: prepare.map((step) => ({ ...step, timeoutMs: 300_000 })), concurrency: 1, write });
    if ([...built.results.values()].some((result) => result.status !== 'pass')) return 1;
  }
  const concurrency = count('concurrency');
  const run = candidateFolder ? { id: basename(resolve(candidateFolder)), folder: resolve(candidateFolder) } : newRun(ROOT);
  if (candidateFolder && existsSync(join(run.folder, 'manifest.json'))) throw new Error('candidate acceptance cannot reuse an existing run manifest');
  write(`RUN  ${tests.length} test files with ${concurrency} at once, each test limited to ${limitMs / 1000}s and no limit for a file; run ${run.id} keeps its output and manifest in ${run.folder}`);
  const beforeEach = values['when-idle'] === undefined ? undefined : whenIdle(count('when-idle'), { write });
  // A run passes when every file passed and a file ran a test (runTests).
  const { passed } = await runTests({ tests, concurrency, write, beforeEach, run });
  if (candidateFolder) {
    const path = join(run.folder, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, `${JSON.stringify({ ...manifest, script: scriptName, selection }, null, 2)}\n`);
  }
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

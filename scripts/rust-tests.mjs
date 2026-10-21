// Runs the tests of a Rust package one at a time, each as a process of its own with its own limit, through the test runner
// (docs/operations/examples.md#test-runner). Cargo names the test executables (`--message-format=json`), each executable names its
// tests (`--list`), and each test runs as `<executable> --exact <name>` in the package folder, as cargo runs it. A test that does
// not end is killed at its limit and reported with its name and elapsed time, and the next test still runs.
// Usage: node scripts/rust-tests.mjs --manifest <Cargo.toml> --package <package> [--features <list>] [--test <name>]
//   [--count <n>] [--timeout <seconds>]
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { loadavg } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runTests } from './test-runner.mjs';

/** The limit of one test when `--timeout` is not given. */
export const TEST_TIMEOUT_MS = 120_000;

/** The names of the tests in the output of `<executable> --list`. */
export function testNames(listing) {
  return listing.split('\n').map((line) => /^(.+): test$/.exec(line)?.[1]).filter((name) => name !== undefined);
}

/** The test executables and their target names in the JSON messages of `cargo test --no-run --message-format=json`. */
export function testExecutables(messages) {
  const found = new Map();
  for (const line of messages.split('\n')) {
    if (!line.startsWith('{')) continue;
    const message = JSON.parse(line);
    if (message.reason === 'compiler-artifact' && message.profile?.test === true && message.executable) {
      found.set(message.executable, message.target.name);
    }
  }
  return [...found].map(([path, target]) => ({ path, target }));
}

function cargo(args, { cwd } = {}) {
  return execFileSync('cargo', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/** The folder of the package, where cargo runs its tests. */
function packageFolder(manifest, pkg) {
  const metadata = JSON.parse(cargo(['metadata', '--no-deps', '--format-version', '1', '--manifest-path', manifest]));
  const found = metadata.packages.find((item) => item.name === pkg);
  if (found === undefined) throw new Error(`${pkg} is not a package of ${manifest}`);
  return dirname(found.manifest_path);
}

/**
 * Runs the tests of the package `count` times (`{manifest, package, features?, test?, count, timeoutMs, write}`), each test as
 * `<executable> --exact <name>`. Resolves with the exit status: 0 when every test of every run passed and ran.
 */
export async function runRustTests({ manifest, package: pkg, features, test, count, timeoutMs, write }) {
  const cargoArgs = ['test', '-q', '--manifest-path', manifest, '-p', pkg, ...(features ? ['--features', features] : [])];
  const executables = testExecutables(cargo([...cargoArgs, '--no-run', '--message-format=json']));
  if (executables.length === 0) throw new Error(`${pkg} has no test executables`);
  const cwd = packageFolder(manifest, pkg);
  const listed = executables.flatMap(({ path, target }) => testNames(execFileSync(path, ['--list'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  })).map((name) => ({ path, target, name })));
  if (listed.length === 0) throw new Error(`${pkg} has no tests`);
  const chosen = test === undefined ? listed : listed.filter((item) => item.name === test);
  if (chosen.length === 0) throw new Error(`${pkg} has no test named ${test}`);
  // A name that two executables hold is shown with its target, so each test has a name of its own in the runner.
  const occurrences = new Map();
  for (const item of listed) occurrences.set(item.name, (occurrences.get(item.name) ?? 0) + 1);
  const tests = chosen.map((item) => ({
    name: occurrences.get(item.name) > 1 ? `${item.target} ${item.name}` : item.name,
    command: item.path, args: ['--exact', item.name], cwd,
  }));
  for (let run = 1; run <= count; run += 1) {
    write(`START ${pkg}: run ${run} of ${count}, ${tests.length} tests, each limited to ${timeoutMs / 1000}s`);
    const { results } = await runTests({ tests, concurrency: 1, defaultTimeoutMs: timeoutMs, write });
    const failed = [...results].filter(([, result]) => result.status !== 'pass' || !/\b1 passed\b/.test(result.output));
    for (const [name, result] of failed) {
      if (result.status === 'pass') write(`FAIL ${name} reports no passed test`);
    }
    if (failed.length > 0) {
      write(`FAIL: ${pkg} run ${run} of ${count}; load ${loadavg().map((value) => value.toFixed(2)).join(' ')}`);
      return 1;
    }
  }
  write(`${pkg}${test === undefined ? '' : ` ${test}`}: ${count} of ${count} runs pass`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    args: process.argv.slice(2), strict: true,
    options: {
      manifest: { type: 'string', default: 'Cargo.toml' },
      package: { type: 'string' },
      features: { type: 'string' },
      test: { type: 'string' },
      count: { type: 'string', default: '1' },
      timeout: { type: 'string' },
    },
  });
  if (values.package === undefined) throw new Error('--package is required');
  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1) throw new Error(`--count must be a positive integer, found ${JSON.stringify(values.count)}`);
  const timeoutMs = values.timeout === undefined ? TEST_TIMEOUT_MS : Number(values.timeout) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
    throw new Error(`--timeout must be seconds from 0 up to 600, found ${JSON.stringify(values.timeout)}`);
  }
  runRustTests({
    manifest: values.manifest, package: values.package, features: values.features, test: values.test, count, timeoutMs,
    write: (line) => process.stdout.write(`${line}\n`),
  }).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

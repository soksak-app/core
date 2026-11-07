// Runs the tests of the Go packages of a pattern one at a time, each as a process of its own with its own limit, through the test
// runner (docs/operations/examples.md#test-parity). Each package with test files is compiled once with `go test -c`; each test runs
// as the test binary with `-test.run ^<name>$` and `-test.timeout` of its limit in the package folder, as go test runs it, so
// `t.Deadline` reports the limit. A test that does not end panics at its limit with the stacks of its goroutines and is reported
// with its name and elapsed time, and the next test still runs. A package of the pattern with no test files does
// not decide the run; the run fails when no package has test files or no test matches. The build reads the environment of the
// caller (MACOSX_DEPLOYMENT_TARGET, CGO_CFLAGS), and a build whose link reports an object newer than the link fails the run
// (macos-minimum.mjs).
// Usage: node scripts/go-tests.mjs --package <pattern> [--tags <tags>] [--test <regexp>] [--count <n>] [--timeout <seconds>]
//   [--ldflags <flags>]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runBuild } from './macos-minimum.mjs';
import { runTests } from './test-runner.mjs';
import { resolveGoNativeInputs } from './go-repeat-inputs.mjs';

/** The limit of one test when `--timeout` is not given. */
export const TEST_TIMEOUT_MS = 120_000;

/** The names of the tests in the output of `<binary> -test.list`; benchmarks and examples are not tests. */
export function testNames(listing) {
  return listing.split('\n').filter((line) => /^Test[A-Za-z0-9_]*$/.test(line));
}

/** Whether the verbose output of the test binary reports the test as passed. */
export function passedTest(output, name) {
  return output.split('\n').some((line) => line.startsWith(`--- PASS: ${name} `));
}

function go(args, options = {}) {
  return execFileSync('go', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
}

/**
 * Runs the tests of the packages of `pattern` `count` times (`{pattern, tags?, test?, count, timeoutMs, ldflags?, write}`), each test
 * as the test binary of its package with `-test.run ^<name>$`. Resolves with the exit status: 0 when every test of every run passed
 * and ran.
 */
export async function runGoTests({ pattern, tags = '', test, count, timeoutMs, ldflags = '', cgoLdflags = '', cwd = process.cwd(), env = process.env, write }) {
  const inputs = resolveGoNativeInputs({ patterns: [pattern], tags, cwd, env });
  const selectedEnv = inputs.env;
  const linkerFlags = [ldflags, ...(inputs.cgoEnabled ? [cgoLdflags] : [])].filter(Boolean).join(' ');
  const tagArgs = tags ? ['-tags', tags] : [];
  const packages = go(['list', ...tagArgs, '-f', '{{.ImportPath}}\t{{.Dir}}\t{{len .TestGoFiles}}\t{{len .XTestGoFiles}}', pattern], { cwd, env: selectedEnv })
    .trim().split('\n').map((line) => {
      const [importPath, dir, sources, external] = line.split('\t');
      return { importPath, dir, files: Number(sources) + Number(external) };
    });
  const testable = packages.filter((item) => item.files > 0);
  if (testable.length === 0) throw new Error(`${pattern} has no test files built with tags '${tags}'`);
  const folder = mkdtempSync(join(tmpdir(), 'soksak-go-tests-'));
  try {
    const listed = [];
    for (const [index, item] of testable.entries()) {
      const binary = join(folder, `test-${index}.binary`);
      await runBuild('go', ['test', '-c', '-o', binary, ...tagArgs, ...(linkerFlags ? ['-ldflags', linkerFlags] : []), item.importPath], { cwd, env: selectedEnv });
      const names = testNames(execFileSync(binary, ['-test.list', '.*'], { cwd: item.dir, env: selectedEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
      for (const name of test === undefined ? names : names.filter((candidate) => new RegExp(test).test(candidate))) {
        listed.push({ importPath: item.importPath, name, binary, cwd: item.dir });
      }
    }
    if (listed.length === 0) throw new Error(test === undefined ? `${pattern} has no tests` : `${pattern} has no test matching ${test}`);
    // A name that two packages hold is shown with its package, so each test has a name of its own in the runner.
    const occurrences = new Map();
    for (const item of listed) occurrences.set(item.name, (occurrences.get(item.name) ?? 0) + 1);
    const tests = listed.map((item) => ({
      name: occurrences.get(item.name) > 1 ? `${item.importPath} ${item.name}` : item.name,
      command: item.binary, args: ['-test.run', `^${item.name}$`, '-test.v', '-test.count=1', `-test.timeout=${timeoutMs}ms`], cwd: item.cwd,
      passedAs: item.name, timeoutMs, stacksAtLimit: true, env: selectedEnv,
    }));
    for (let run = 1; run <= count; run += 1) {
      write(`START ${pattern}: run ${run} of ${count}, ${tests.length} tests, each limited to ${timeoutMs / 1000}s`);
      const { results } = await runTests({ tests, concurrency: 1, write });
      const failed = tests.filter((item) => {
        const result = results.get(item.name);
        return result.status !== 'pass' || !passedTest(result.output, item.passedAs);
      });
      for (const item of failed) {
        if (results.get(item.name).status === 'pass') write(`FAIL ${item.name} reports no passed test`);
      }
      if (failed.length > 0) {
        write(`FAIL: ${pattern} run ${run} of ${count}; load ${loadavg().map((value) => value.toFixed(2)).join(' ')}`);
        return 1;
      }
    }
    write(`${pattern}${test === undefined ? '' : ` ${test}`}: ${count} of ${count} runs pass`);
    return 0;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    args: process.argv.slice(2), strict: true,
    options: {
      package: { type: 'string' },
      tags: { type: 'string' },
      test: { type: 'string' },
      count: { type: 'string', default: '1' },
      timeout: { type: 'string' },
      ldflags: { type: 'string' },
      'cgo-ldflags': { type: 'string' },
    },
  });
  if (values.package === undefined) throw new Error('--package is required');
  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1) throw new Error(`--count must be a positive integer, found ${JSON.stringify(values.count)}`);
  const timeoutMs = values.timeout === undefined ? TEST_TIMEOUT_MS : Number(values.timeout) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
    throw new Error(`--timeout must be seconds from 0 up to 600, found ${JSON.stringify(values.timeout)}`);
  }
  runGoTests({
    pattern: values.package, tags: values.tags, test: values.test, count, timeoutMs, ldflags: values.ldflags, cgoLdflags: values['cgo-ldflags'],
    write: (line) => process.stdout.write(`${line}\n`),
  }).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

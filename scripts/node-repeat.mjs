// Runs the tests of one Node test file whose names match a pattern COUNT times in a row, each repeat as one process of `node --test`
// through the test runner (docs/operations/examples.md#test-runner). A repeat has the limit TEST_TIMEOUT: the runner kills its process
// group at the limit, and `--test-timeout` gives each test of the repeat the same limit, so a test that hangs is reported with its name
// and elapsed time. A repeat fails when it fails or when no passed test matches the pattern.
// Usage: node scripts/node-repeat.mjs --file <file> --name <pattern> --count <n> [--timeout <seconds>]
import { loadavg } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runTests } from './test-runner.mjs';

/** The limit of one repeat when `--timeout` is not given. */
export const TEST_TIMEOUT_MS = 120_000;

const ANSI = /\x1b\[[0-9;]*m/g;

/** The passed test lines (`ok <n> - <title>`) of the TAP output of a repeat; a skipped test is not passed. */
export function passedLines(tap) {
  return tap.replace(ANSI, '').split('\n').filter((line) => /^\s*ok \d+ - /.test(line) && !line.includes('# SKIP'));
}

/**
 * Runs the file `count` times (`{file, name, count, timeoutMs, cwd, write}`). Resolves with the exit status: 0 when every repeat passed.
 * Rejects when no passed test of the file matches the pattern, because the file then proves nothing.
 */
export async function runNodeRepeat({ file, name, count, timeoutMs, cwd, write }) {
  for (let run = 1; run <= count; run += 1) {
    const item = {
      name: `${file} ${name} (run ${run} of ${count})`,
      // A repeat started from a test sees NODE_TEST_CONTEXT, and node --test then skips the file; env removes the variable for the repeat.
      command: '/usr/bin/env',
      args: ['-u', 'NODE_TEST_CONTEXT', process.execPath, '--test', '--experimental-test-module-mocks', '--test-reporter=tap', `--test-name-pattern=${name}`, `--test-timeout=${timeoutMs}`, file],
      cwd,
    };
    const { results } = await runTests({ tests: [item], concurrency: 1, defaultTimeoutMs: timeoutMs, write });
    const result = results.get(item.name);
    if (result.status !== 'pass') {
      write(`FAIL: ${file} ${name} run ${run} of ${count}; load ${loadavg().map((value) => value.toFixed(2)).join(' ')}`);
      return 1;
    }
    const lines = passedLines(result.output);
    for (const line of lines) write(`  ${line.trim()}`);
    if (!lines.some((line) => new RegExp(name).test(line.replace(/^\s*ok \d+ - /, '')))) {
      throw new Error(`FAIL: no test in ${file} matched ${name}`);
    }
  }
  write(`${file} ${name}: ${count} of ${count} runs pass`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    args: process.argv.slice(2), strict: true,
    options: {
      file: { type: 'string' },
      name: { type: 'string' },
      count: { type: 'string', default: '1' },
      timeout: { type: 'string' },
    },
  });
  if (values.file === undefined || values.name === undefined) throw new Error('--file and --name are required');
  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1) throw new Error(`--count must be a positive integer, found ${JSON.stringify(values.count)}`);
  const timeoutMs = values.timeout === undefined ? TEST_TIMEOUT_MS : Number(values.timeout) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
    throw new Error(`--timeout must be seconds from 0 up to 600, found ${JSON.stringify(values.timeout)}`);
  }
  runNodeRepeat({
    file: values.file, name: values.name, count, timeoutMs, cwd: process.cwd(),
    write: (line) => process.stdout.write(`${line}\n`),
  }).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

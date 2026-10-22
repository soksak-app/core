// Runs the test files of the push gate, each as a `node --test` process of its own with its own limit, through the test runner
// (docs/operations/examples.md#test-runner). Each file is named when it starts and reported with its result and elapsed time; a file
// over its limit is killed and reported as TIME, and the next file still runs.
// Usage: node scripts/gate-tests.mjs [--timeout <seconds>] <test file>...
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runTests } from './test-runner.mjs';

/** The limit of one test file when `--timeout` is not given. */
export const TEST_TIMEOUT_MS = 120_000;

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Runs the test files (paths relative to `root`) with `timeoutMs` as the limit of each. Resolves with the exit status: 0 when every
 * file passed.
 */
export async function runGateTests({ files, timeoutMs, write }) {
  if (files.length === 0) throw new Error('no test file is given');
  // The gate runs from the push hook, outside a test; NODE_TEST_CONTEXT of a test run would make node --test skip its files, so env removes it.
  const tests = files.map((file) => ({
    name: file, command: '/usr/bin/env', args: ['-u', 'NODE_TEST_CONTEXT', process.execPath, '--test', file], cwd: root, timeoutMs,
  }));
  const { results } = await runTests({ tests, concurrency: 1, write });
  return [...results.values()].every((result) => result.status === 'pass') ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2), strict: true, allowPositionals: true,
    options: { timeout: { type: 'string' } },
  });
  const timeoutMs = values.timeout === undefined ? TEST_TIMEOUT_MS : Number(values.timeout) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
    throw new Error(`--timeout must be seconds from 0 up to 600, found ${JSON.stringify(values.timeout)}`);
  }
  runGateTests({ files: positionals, timeoutMs, write: (line) => process.stdout.write(`${line}\n`) }).then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

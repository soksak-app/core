// Runs the native tests (native/darwin/Makefile) one at a time through the test runner: they open windows and share the screen, so
// they do not run in parallel, and each one is named when it starts and ends with its elapsed time and has a limit of its own
// (docs/operations/examples.md#test-runner). The tests are executables of the build folder; a test with arguments is written as
// `<executable>,<argument>,...`, because a space would split the list in the Makefile.
import { fileURLToPath } from 'node:url';
import { runTests } from './test-runner.mjs';

/** The limit of one native test. */
const TEST_TIMEOUT_MS = 120_000;

/** The tests of a list of `<executable relative to dir>[,<argument>...]` entries. */
export function nativeTests(dir, list) {
  if (list.length === 0) throw new Error('there is no native test to run');
  const names = new Set();
  return list.map((entry) => {
    if (names.has(entry)) throw new Error(`the native test ${entry} is listed twice`);
    names.add(entry);
    const [executable, ...args] = entry.split(',');
    return { name: entry.replaceAll(',', ' '), command: `${dir}/${executable}`, args };
  });
}

/** Runs the tests one at a time and returns the exit status: 0 when every test passed. */
export async function runNativeTests({ dir, list, timeoutMs = TEST_TIMEOUT_MS, write }) {
  const { results } = await runTests({ tests: nativeTests(dir, list).map((item) => ({ ...item, timeoutMs })), concurrency: 1, write });
  return [...results.values()].every((result) => result.status === 'pass') ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, ...list] = process.argv.slice(2);
  const only = process.env.NATIVE_TEST_ONLY ?? '';
  const chosen = list.filter((entry) => entry.includes(only));
  runNativeTests({ dir, list: chosen, write: (line) => process.stdout.write(`${line}\n`) }).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

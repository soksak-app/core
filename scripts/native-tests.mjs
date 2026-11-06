// Runs the native tests (native/darwin/Makefile) one at a time through the test runner: they open windows and share the screen, so
// they do not run in parallel, and each one is named when it starts and ends with its elapsed time and has a limit of its own
// (docs/operations/examples.md#test-parity). The tests are executables of the build folder; a test with arguments is written as
// `<executable>,<argument>,...`, because a space would split the list in the Makefile. An entry `build:<executable>,<argument>,...`
// declares the build of the tests of that executable: the runner runs the executable with those arguments before each of them, in a
// process of its own under BUILD_TIMEOUT_MS, so the limit of the test measures only the test.
import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';
import { MAX_TEST_TIMEOUT_MS, runTests } from './test-runner.mjs';

/** The limit of one native test. */
const TEST_TIMEOUT_MS = 120_000;

/** The limit of the build of a native test. */
export const BUILD_TIMEOUT_MS = MAX_TEST_TIMEOUT_MS;

const BUILD_PREFIX = 'build:';

/**
 * The tests of a list of `<executable relative to dir>[,<argument>...]` entries and `build:<executable>[,<argument>...]` declarations.
 * A test of an executable with a declared build carries it. A build applies to the tests of its executable that the list holds, so a
 * list that selects other tests carries no build; an executable with two builds is refused.
 */
export function nativeTests(dir, list) {
  const builds = new Map();
  for (const entry of list.filter((item) => item.startsWith(BUILD_PREFIX))) {
    const [executable, ...args] = entry.slice(BUILD_PREFIX.length).split(',');
    if (executable === '') throw new Error(`the native test build ${entry} names no executable`);
    if (builds.has(executable)) throw new Error(`the native test executable ${executable} has two builds`);
    builds.set(executable, { command: `${dir}/${executable}`, args, timeoutMs: BUILD_TIMEOUT_MS });
  }
  const tests = list.filter((item) => !item.startsWith(BUILD_PREFIX));
  if (tests.length === 0) throw new Error('there is no native test to run');
  const names = new Set();
  return tests.map((entry) => {
    if (names.has(entry)) throw new Error(`the native test ${entry} is listed twice`);
    names.add(entry);
    const [executable, ...args] = entry.split(',');
    const build = builds.get(executable);
    return { name: entry.replaceAll(',', ' '), command: `${dir}/${executable}`, args, ...(build ? { build } : {}) };
  });
}

/** Runs the tests one at a time and returns the exit status: 0 when every test passed. */
export async function runNativeTests({ dir, list, timeoutMs = TEST_TIMEOUT_MS, write, run, env }) {
  const { results } = await runTests({ tests: nativeTests(dir, list).map((item) => ({ ...item, timeoutMs })), concurrency: 1, write, run, env });
  return [...results.values()].every((result) => result.status === 'pass') ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, ...list] = process.argv.slice(2);
  const only = process.env.NATIVE_TEST_ONLY ?? '';
  const chosen = list.filter((entry) => entry.startsWith(BUILD_PREFIX) || entry.includes(only));
  const outputFolder = process.env.SOKSAK_NATIVE_TEST_RUN_FOLDER;
  const run = outputFolder ? { id: basename(resolve(outputFolder)), folder: resolve(outputFolder) } : undefined;
  runNativeTests({ dir, list: chosen, write: (line) => process.stdout.write(`${line}\n`), run, env: process.env }).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

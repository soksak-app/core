// The execution evidence shared by discovered Node files, repeated selections and language cases.
import { fileURLToPath } from 'node:url';
import { EVENT_PREFIX } from './test-event-reporter.mjs';

const reporter = fileURLToPath(new URL('./test-event-reporter.mjs', import.meta.url));
/**
 * The reporters of a node --test file that the test runner runs with `eventLimitMs`: the spec form on the standard output, the TAP form on
 * the standard error, and the events of scripts/test-event-reporter.mjs on the standard error, which the runner reads for the event
 * watchdog of the file and for the tests that the file ran. The spec form writes the errors of the failed tests at the end of the file,
 * so a file that is killed keeps none; the TAP form writes the error of each test when the test ends.
 */
export const NODE_TEST_REPORTERS = Object.freeze([
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=tap', '--test-reporter-destination=stderr',
  `--test-reporter=${reporter}`, '--test-reporter-destination=stderr',
]);

/** Installs the same reporters without retaining a caller's duplicate reporters or destinations. */
export function withNodeTestReporters(args) {
  const filtered = [];
  for (let index = 0; index < args.length; index++) {
    if (/^--test-reporter(?:-destination)?=/.test(args[index])) continue;
    if (/^--test-reporter(?:-destination)?$/.test(args[index])) { index++; continue; }
    filtered.push(args[index]);
  }
  const at = filtered.indexOf('--test');
  return at < 0 ? filtered : [...filtered.slice(0, at + 1), ...NODE_TEST_REPORTERS, ...filtered.slice(at + 1)];
}

/** The shared acceptance rule concerns executed cases, not the success of the containing command. */
export function testExecutionErrors(actual) {
  const errors = [];
  if (actual.tests === 0) errors.push('zero tests reported');
  for (const [field, description] of [['failed', 'failed'], ['skipped', 'skipped'], ['cancelled', 'cancelled'], ['todo', 'marked todo']]) {
    if (actual[field] > 0) errors.push(`${actual[field]} test(s) ${description}`);
  }
  return errors;
}

/** Accumulates file-owned summaries; an outer successful file wrapper supplies none. */
export function createNodeTestEvidence(files) {
  const summaries = new Map();
  const omitted = [];
  return {
    track(event) {
      if (event.type === 'test:summary' && typeof event.file === 'string') summaries.set(event.file, event);
      if (event.type === 'test:complete' && (event.skip || event.todo)) {
        omitted.push({ kind: event.skip ? 'skipped' : 'todo', name: event.name });
      }
    },
    result() {
      const actual = { tests: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
      const errors = [];
      const expected = [...new Set(files)];
      if (expected.length === 0) errors.push('missing declared Node test files');
      for (const file of new Set([...expected, ...summaries.keys()])) {
        const summary = summaries.get(file);
        const counts = summary?.counts;
        if (!counts || ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'].some((key) => !Number.isInteger(counts[key]) || counts[key] < 0)) {
          errors.push(`missing or incomplete test evidence for ${file}: ${JSON.stringify(counts ?? null)}`);
          continue;
        }
        actual.tests += counts.passed + counts.failed;
        for (const key of ['failed', 'cancelled', 'skipped', 'todo']) actual[key] += counts[key];
        if (summary.success !== true || counts.tests < 1 || counts.passed < 1) {
          errors.push(`missing or incomplete test evidence for ${file}: ${JSON.stringify(counts)}`);
        }
      }
      // Skipped suites are absent from Node's test totals, so their completion events are required too.
      for (const key of ['skipped', 'todo']) actual[key] = Math.max(actual[key], omitted.filter(({ kind }) => kind === key).length);
      errors.push(...testExecutionErrors(actual));
      if (omitted.length > 0) errors.push(`incomplete test evidence: ${omitted.map(({ kind, name }) => `${kind}: ${name}`).join('; ')}`);
      return { actual, errors };
    },
  };
}

/** Reads the event reporter's lines, never the TAP or spec reporter's wrapper totals. */
export function readNodeTestEvidence(output, files = []) {
  const evidence = createNodeTestEvidence(files);
  for (const line of output.split('\n')) {
    if (line.startsWith(EVENT_PREFIX)) evidence.track(JSON.parse(line.slice(EVENT_PREFIX.length)));
  }
  return evidence.result();
}

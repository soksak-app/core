// Audits the logs of one run of window checks and judges each test by the log (docs/spec/logging.md#test-marks):
//   node scripts/audit-run.mjs <run folder>
// The run folder (`target/test-runs/<run>`) holds `marks.jsonl`, which the window-check library writes. The marks name the
// configuration folders that the run used, so the audit reads the event files of every layer under them, checks them against
// the catalog (`auditParsed`: declared events, consecutive seq across generations and the debug file, chains, no undeclared
// `error`), and writes `judgment.json` with one row for each test and application. The range of a test is the lines of the
// application log between its `host.test.start` and `host.test.end` marks, by `(boot, seq)`; the events of another process are
// placed in the range by `ts_us`, because their `seq` is not that of the application log. The findings are lines
// `<file>:<line>: <message>`, and the exit status is 1 when there is one.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditParsed, parseLog, processOf } from '../packages/log-contract/index.js';
import { eventLine } from '../packages/window-check/event-log.mjs';
import { catalogOf, eventFiles } from './check-events.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const KINDS = ['start', 'end', 'expect_error', 'expect_event'];

/** The records of `marks.jsonl` with their line numbers. A record outside the form is an error that names the line. */
function readMarks(folder) {
  const file = join(folder, 'marks.jsonl');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${file}: the run left no test marks (a window check writes them while SOKSAK_RUN_ID is set)`, { cause: error });
    throw error;
  }
  const lines = text.split('\n').filter((raw, index, all) => raw !== '' || index < all.length - 1);
  if (lines.length === 0) throw new Error(`${file}: the run left no test marks`);
  const marks = lines.map((raw, index) => {
    const line = index + 1;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      throw new Error(`${file}:${line}: not JSON: ${raw}`);
    }
    if (!KINDS.includes(record?.kind)) throw new Error(`${file}:${line}: kind ${record?.kind} is not ${KINDS.slice(0, -1).join(', ')} or ${KINDS.at(-1)}`);
    const need = (name, type) => {
      if (typeof record[name] !== type || (type === 'string' && record[name] === '' && name !== 'flags')) throw new Error(`${file}:${line}: ${record.kind} needs ${name} as a ${type}, found ${JSON.stringify(record[name])}`);
    };
    for (const name of ['run', 'app', 'config', 'name']) need(name, 'string');
    if (record.kind === 'start' || record.kind === 'end') {
      need('boot', 'string');
      need('seq', 'number');
    }
    if (record.kind === 'expect_error') {
      need('pattern', 'string');
      need('flags', 'string');
    }
    if (record.kind === 'expect_event') need('event', 'string');
    return { ...record, line };
  });
  return { file, marks };
}

/** The tests of the marks: one case for each start mark with its end mark and its declarations. */
function casesOf(file, marks) {
  const cases = [];
  const open = new Map();
  for (const mark of marks) {
    const key = `${mark.app}\0${mark.name}`;
    if (mark.kind === 'start') {
      const made = { name: mark.name, app: mark.app, config: mark.config, run: mark.run, start: mark, end: null, patterns: [], expected: [], errors: [], found: new Map() };
      cases.push(made);
      open.set(key, made);
      continue;
    }
    const made = open.get(key);
    if (made === undefined) throw new Error(`${file}:${mark.line}: ${mark.kind} of ${mark.name} has no open start mark`);
    if (mark.kind === 'end') {
      made.end = mark;
      open.delete(key);
    } else if (mark.kind === 'expect_error') made.patterns.push(new RegExp(mark.pattern, mark.flags));
    else if (!made.expected.includes(mark.event)) made.expected.push(mark.event);
  }
  return cases;
}

/** The audit of the logs of a run. Writes `judgment.json` in the folder and returns the findings `<file>:<line>: <message>`. */
export function auditRun(catalog, folder) {
  const { file: marksFile, marks } = readMarks(folder);
  const cases = casesOf(marksFile, marks);
  const findings = [];
  const configs = [...new Set(marks.map((mark) => mark.config))];
  for (const config of configs) {
    const parsed = eventFiles(config).map((file) => ({ file, process: processOf(file), entries: parseLog(file, readFileSync(file, 'utf8')).map((entry) => ({ ...entry, file })) }));
    // The position (boot, seq) of every line of the application log.
    const positions = new Map();
    for (const { file, process, entries } of parsed) {
      if (!process.startsWith('host-')) continue;
      for (const { line, event } of entries) positions.set(`${process.slice('host-'.length)}\0${event.seq}`, { file, line, seq: event.seq, ts_us: event.ts_us });
    }
    const mine = cases.filter((made) => made.config === config);
    for (const made of mine) {
      made.boot = made.start.boot;
      made.from = positions.get(`${made.start.boot}\0${made.start.seq}`);
      made.to = made.end === null ? null : positions.get(`${made.end.boot}\0${made.end.seq}`);
      if (made.from === undefined) throw new Error(`${marksFile}:${made.start.line}: the start mark (${made.start.boot}, ${made.start.seq}) of ${made.name} is not in the logs of ${config}`);
      if (made.end !== null && made.to === undefined) throw new Error(`${marksFile}:${made.end.line}: the end mark (${made.end.boot}, ${made.end.seq}) of ${made.name} is not in the logs of ${config}`);
    }
    const inRange = (made, process, entry) => {
      const { from, to } = made;
      if (process.startsWith('host-')) {
        return process.slice('host-'.length) === made.boot && entry.event.seq > from.seq && (to === null || entry.event.seq < to.seq);
      }
      return entry.event.ts_us >= from.ts_us && (to === null || entry.event.ts_us <= to.ts_us);
    };
    const expectedNames = new Set(mine.flatMap((made) => made.expected));
    const declared = new Set();
    for (const { file, process, entries } of parsed) {
      for (const entry of entries) {
        const isError = entry.event.level === 'error';
        if (!isError && !expectedNames.has(entry.event.event)) continue;
        const inside = mine.filter((made) => inRange(made, process, entry));
        if (expectedNames.has(entry.event.event)) {
          for (const made of inside) made.found.set(entry.event.event, (made.found.get(entry.event.event) ?? 0) + 1);
        }
        if (!isError) continue;
        const text = eventLine(entry.event);
        const flags = inside.map((made) => {
          const ok = made.patterns.some((pattern) => pattern.test(text));
          made.errors.push({ file, line: entry.line, text, declared: ok });
          return ok;
        });
        if (flags.length > 0 && flags.every(Boolean)) declared.add(`${file}\0${entry.line}`);
      }
    }
    // The run spans from its first start mark to its last end mark. A configuration folder also holds the logs of earlier
    // runs and of a person's use of the application, and an error outside the span belongs to no test of this run, so this
    // run does not judge it; `check-events.mjs --logs` reports every error of a folder.
    const spanStart = Math.min(...mine.map((made) => made.from.ts_us));
    const spanEnd = mine.some((made) => made.to === null) ? Infinity : Math.max(...mine.map((made) => made.to.ts_us));
    const judged = (entry) => entry.event.ts_us >= spanStart && entry.event.ts_us <= spanEnd;
    for (const { file, line, message } of auditParsed(parsed, catalogOf(catalog, config),
      (file, entry) => declared.has(`${file}\0${entry.line}`) || !judged(entry))) {
      findings.push(`${file}:${line}: ${message}`);
    }
  }
  const rows = cases.map((made) => {
    const missing = made.expected.filter((name) => !made.found.has(name));
    const row = {
      name: made.name, app: made.app,
      result: made.end !== null && missing.length === 0 && made.errors.every(({ declared }) => declared) ? 'pass' : 'fail',
      boot: made.boot,
      from: { seq: made.from.seq, file: made.from.file, line: made.from.line },
      to: made.to === null ? null : { seq: made.to.seq, file: made.to.file, line: made.to.line },
      errors: made.errors,
      expected: made.expected.map((event) => ({ event, found: made.found.get(event) ?? 0 })),
      missing,
    };
    if (made.end === null) {
      findings.push(`${marksFile}:${made.start.line}: test ${made.name} of ${made.app} has a start mark and no end mark`);
    } else if (missing.length > 0) {
      for (const name of missing) {
        findings.push(`${marksFile}:${made.end.line}: test ${made.name} of ${made.app} expected the event ${name} and ${made.from.file} lines ${made.from.line}-${made.to.line} hold none`);
      }
    }
    return row;
  });
  writeFileSync(join(folder, 'judgment.json'), `${JSON.stringify({ schema: 1, run: marks[0].run, tests: rows }, null, 2)}\n`);
  return findings;
}

/** The audit of a run against the catalog of this repository. */
export function auditRunWithCatalog(folder) {
  return auditRun(JSON.parse(readFileSync(join(ROOT, 'docs/spec/events.json'), 'utf8')), folder);
}

/** Audits the run folder against the catalog of this repository, reports the findings and returns the exit status. */
export function main(argv, write = (line) => process.stderr.write(`${line}\n`)) {
  if (argv.length !== 1) throw new Error('usage: node scripts/audit-run.mjs <run folder>');
  const findings = auditRunWithCatalog(argv[0]);
  for (const finding of findings) write(finding);
  process.stdout.write(findings.length === 0 ? `Run log audit passed: ${basename(argv[0])}\n` : `Run log audit failed: ${findings.length} findings in ${basename(argv[0])}, judgment in ${join(argv[0], 'judgment.json')}\n`);
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

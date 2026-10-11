import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { auditRun } from '../audit-run.mjs';

const catalog = {
  schema: 1,
  layers: ['host', 'sidecar'],
  events: {
    'log.open': { layer: 'host', class: 'lifecycle', level: 'info', fields: { schema: 'number', pid: 'number', role: 'string', boot: 'string' } },
    'host.test.start': { layer: 'host', class: 'lifecycle', level: 'info', fields: { name: 'string', run: 'string' } },
    'host.test.end': { layer: 'host', class: 'lifecycle', level: 'info', fields: { name: 'string', run: 'string', result: 'string' } },
    'host.window.event': { layer: 'host', class: 'lifecycle', level: 'info', fields: { window: 'string', kind: 'string' } },
    'host.update.start': { layer: 'host', class: 'lifecycle', level: 'info', fields: {} },
    'host.record.<level>': { layer: 'host', class: 'lifecycle', level: ['error', 'info'], fields: { where: 'string', text: 'string' } },
    'sidecar.record.<level>': { layer: 'sidecar', class: 'lifecycle', level: ['error', 'info'], fields: { where: 'string', text: 'string' } },
  },
};

const BOOT = '1-2';
const US = 1_791_000_000_000_000;
const event = (seq, name, fields, extra = {}) => JSON.stringify({ ts_us: US + seq * 1000, seq, level: 'info', layer: 'host', event: name, fields, ...extra });
const open = (role, boot, seq = 1) => event(seq, 'log.open', { schema: 1, pid: 3, role, boot }, { layer: role === 'host' ? 'host' : 'sidecar' });
const start = (seq, name) => event(seq, 'host.test.start', { name, run: 'run-1' });
const end = (seq, name, result = 'pass') => event(seq, 'host.test.end', { name, run: 'run-1', result });
const failure = (seq, text) => event(seq, 'host.record.error', { where: 'place', text }, { level: 'error' });
const focus = (seq) => event(seq, 'host.window.event', { window: 'w', kind: 'focus' });

/** A run folder with a configuration folder holding `files` (name to lines) and `marks` (records of marks.jsonl). */
function fixture(t, { files, marks }) {
  const root = mkdtempSync(join(tmpdir(), 'audit-run-'));
  t.after(() => rmSync(root, { recursive: true }));
  const config = join(root, 'config');
  mkdirSync(join(config, 'logs'), { recursive: true });
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(config, 'logs', name), `${lines.join('\n')}\n`);
  const folder = join(root, 'run');
  mkdirSync(folder);
  const mark = (record) => ({ run: 'run-1', app: 'fixture', config, name: 't1', ts_us: US, ...record });
  writeFileSync(join(folder, 'marks.jsonl'), marks(mark).map((record) => JSON.stringify(record)).join('\n') + '\n');
  return { root, config, folder, host: join(config, 'logs', `host-${BOOT}.jsonl`) };
}

const judgment = (folder) => JSON.parse(readFileSync(join(folder, 'judgment.json'), 'utf8'));

test('a test whose range holds its expected events and only declared errors passes, and its row names the lines', (t) => {
  const { folder, host } = fixture(t, {
    files: { [`host-${BOOT}.jsonl`]: [open('host', BOOT), start(2, 't1'), focus(3), failure(4, 'cannot open: /x'), end(5, 't1')] },
    marks: (mark) => [
      mark({ kind: 'start', boot: BOOT, seq: 2 }),
      mark({ kind: 'expect_error', pattern: 'cannot open: .*', flags: '' }),
      mark({ kind: 'expect_event', event: 'host.window.event' }),
      mark({ kind: 'end', boot: BOOT, seq: 5 }),
    ],
  });
  assert.deepEqual(auditRun(catalog, folder), []);
  const { tests } = judgment(folder);
  assert.equal(tests.length, 1);
  assert.deepEqual(tests[0], {
    name: 't1', app: 'fixture', result: 'pass', boot: BOOT,
    from: { seq: 2, file: host, line: 2 }, to: { seq: 5, file: host, line: 5 },
    errors: [{ file: host, line: 4, text: 'error host place: cannot open: /x', declared: true }],
    expected: [{ event: 'host.window.event', found: 1 }], missing: [],
  });
});

test('an error in the range that the test did not declare is a finding with the file and the line, and the row fails', (t) => {
  const { folder, host } = fixture(t, {
    files: { [`host-${BOOT}.jsonl`]: [open('host', BOOT), start(2, 't1'), failure(3, 'boom'), end(4, 't1')] },
    marks: (mark) => [mark({ kind: 'start', boot: BOOT, seq: 2 }), mark({ kind: 'end', boot: BOOT, seq: 4 })],
  });
  assert.deepEqual(auditRun(catalog, folder), [`${host}:3: undeclared error place: boom`]);
  const [row] = judgment(folder).tests;
  assert.equal(row.result, 'fail');
  assert.deepEqual(row.errors.map(({ declared }) => declared), [false]);
});

test('a test that omits an expected event fails with the missing name at its end mark', (t) => {
  const { folder, host } = fixture(t, {
    files: { [`host-${BOOT}.jsonl`]: [open('host', BOOT), start(2, 't1'), end(3, 't1')] },
    marks: (mark) => [
      mark({ kind: 'start', boot: BOOT, seq: 2 }), mark({ kind: 'expect_event', event: 'host.update.start' }), mark({ kind: 'end', boot: BOOT, seq: 3 }),
    ],
  });
  assert.deepEqual(auditRun(catalog, folder), [
    `${join(folder, 'marks.jsonl')}:3: test t1 of fixture expected the event host.update.start and ${host} lines 2-3 hold none`,
  ]);
  const [row] = judgment(folder).tests;
  assert.equal(row.result, 'fail');
  assert.deepEqual(row.missing, ['host.update.start']);
});

test('an error outside every test, and a start mark without an end mark, are findings', (t) => {
  const { folder, host } = fixture(t, {
    files: { [`host-${BOOT}.jsonl`]: [open('host', BOOT), failure(2, 'before'), start(3, 't1'), focus(4)] },
    marks: (mark) => [mark({ kind: 'start', boot: BOOT, seq: 3 })],
  });
  assert.deepEqual(auditRun(catalog, folder), [
    `${host}:2: undeclared error place: before`,
    `${join(folder, 'marks.jsonl')}:1: test t1 of fixture has a start mark and no end mark`,
  ]);
  assert.equal(judgment(folder).tests[0].result, 'fail');
});

test('the logs of every layer under the configuration folders of the marks are audited, and a sidecar error is placed by time', (t) => {
  const sidecar = (seq, text, offset) => JSON.stringify({ ts_us: US + offset, seq, level: 'error', layer: 'sidecar', event: 'sidecar.record.error', fields: { where: 'vt', text } });
  const { folder, config } = fixture(t, {
    files: {
      [`host-${BOOT}.jsonl`]: [open('host', BOOT), start(2, 't1'), event(3, 'host.window.event', { window: 'w' }), end(4, 't1')],
      'vt-3-4.jsonl': [open('vt', '3-4'), sidecar(2, 'inside', 2500), sidecar(3, 'late', 99000)],
    },
    marks: (mark) => [mark({ kind: 'start', boot: BOOT, seq: 2 }), mark({ kind: 'end', boot: BOOT, seq: 4 })],
  });
  const vt = join(config, 'logs', 'vt-3-4.jsonl');
  assert.deepEqual(auditRun(catalog, folder), [
    `${join(config, 'logs', `host-${BOOT}.jsonl`)}:3: field kind is required by host.window.event`,
    `${vt}:2: undeclared error vt: inside`,
    `${vt}:3: undeclared error vt: late`,
  ]);
  const [row] = judgment(folder).tests;
  assert.deepEqual(row.errors.map(({ line, declared }) => [line, declared]), [[2, false]]);
});

test('a run without marks.jsonl, a malformed mark, or a declaration without a start is an error that names the file and line', (t) => {
  const empty = mkdtempSync(join(tmpdir(), 'audit-run-'));
  t.after(() => rmSync(empty, { recursive: true }));
  assert.throws(() => auditRun(catalog, empty), /marks\.jsonl: the run left no test marks/);
  const bad = fixture(t, { files: { [`host-${BOOT}.jsonl`]: [open('host', BOOT)] }, marks: (mark) => [mark({ kind: 'start', boot: BOOT, seq: 1 }), { kind: 'sideways' }] });
  assert.throws(() => auditRun(catalog, bad.folder), /marks\.jsonl:2: kind sideways is not start, end, expect_error or expect_event/);
  const orphan = fixture(t, { files: { [`host-${BOOT}.jsonl`]: [open('host', BOOT)] }, marks: (mark) => [mark({ kind: 'expect_event', event: 'host.update.start' })] });
  assert.throws(() => auditRun(catalog, orphan.folder), /marks\.jsonl:1: expect_event of t1 has no open start mark/);
});

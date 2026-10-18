import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { auditRun } from '../audit-run.mjs';

const catalog = {
  schema: 2,
  layers: ['host', 'sidecar'],
  chains: { input: ['host.sidecar.request'] },
  budget: { lifecycle: { events: 1e12, bytes: 1e15 }, io: { events: 1e12, bytes: 1e15 } },
  events: {
    'host.sidecar.request': { layer: 'host', class: 'io', level: 'info', cids: 'required', fields: { name: 'string' } },
    'log.open': { layer: 'host', class: 'lifecycle', level: 'info', fields: { schema: 'number', pid: 'number', role: 'string', boot: 'string' } },
    'host.test.start': { layer: 'host', class: 'lifecycle', level: 'info', fields: { name: 'string', run: 'string' } },
    'host.test.end': { layer: 'host', class: 'lifecycle', level: 'info', fields: { name: 'string', run: 'string', result: 'string' } },
    'host.window.event': { layer: 'host', class: 'lifecycle', level: 'info', fields: { window: 'string', kind: 'string' } },
    'host.update.start': { layer: 'host', class: 'lifecycle', level: 'info', fields: {} },
    'log.policy': { layer: 'host', class: 'lifecycle', level: 'info', fields: { source: 'string', classes: 'object' } },
    'host.record.<level>': { layer: 'host', class: 'lifecycle', level: ['error', 'info'], fields: { where: 'string', text: 'string' } },
    'sidecar.record.<level>': { layer: 'sidecar', class: 'lifecycle', level: ['error', 'info'], fields: { where: 'string', text: 'string' } },
  },
};

const BOOT = '1-2';
const US = 1_791_000_000_000_000;
const event = (seq, name, fields, extra = {}) => JSON.stringify({ ts_us: US + seq * 1000, mono_ns: 7_000_000_000 + seq * 1_000_000, seq, level: 'info', class: 'lifecycle', layer: 'host', event: name, fields, ...extra });
const open = (role, boot, seq = 1) => event(seq, 'log.open', { schema: 2, pid: 3, role, boot }, { layer: role === 'host' ? 'host' : 'sidecar' });
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

test('an error between the tests of the run, and a start mark without an end mark, are findings', (t) => {
  const { folder, host } = fixture(t, {
    files: { [`host-${BOOT}.jsonl`]: [open('host', BOOT), start(2, 't1'), end(3, 't1'), failure(4, 'between'), start(5, 't2'), focus(6)] },
    marks: (mark) => [mark({ kind: 'start', boot: BOOT, seq: 2 }), mark({ kind: 'end', boot: BOOT, seq: 3 }),
      mark({ kind: 'start', name: 't2', boot: BOOT, seq: 5 })],
  });
  assert.deepEqual(auditRun(catalog, folder), [
    `${host}:4: undeclared error place: between`,
    `${join(folder, 'marks.jsonl')}:3: test t2 of fixture has a start mark and no end mark`,
  ]);
  assert.equal(judgment(folder).tests[1].result, 'fail');
});

test('an error before the first start mark or after the last end mark of the run belongs to no test of the run and is not judged', (t) => {
  // A configuration folder holds the logs of earlier runs and of a person's use of the application.
  const { folder } = fixture(t, {
    files: { [`host-${BOOT}.jsonl`]: [open('host', BOOT), failure(2, 'an earlier run'), start(3, 't1'), end(4, 't1'), failure(5, 'a later use')] },
    marks: (mark) => [mark({ kind: 'start', boot: BOOT, seq: 3 }), mark({ kind: 'end', boot: BOOT, seq: 4 })],
  });
  assert.deepEqual(auditRun(catalog, folder), []);
  assert.equal(judgment(folder).tests[0].result, 'pass');
});

test('a chain finding of an earlier process before the first start mark belongs to no test of the run and is not judged', (t) => {
  // An earlier process of the configuration folder left a chain that stops after its first event. Both processes apply
  // the policy that stores every level, as the debug switch sets it; under the default policy, which stores only error,
  // the chain asks for no hop.
  const chained = { ...catalog, chains: { input: ['host.sidecar.request', 'host.update.start'] } };
  const request = (seq, cid) => event(seq, 'host.sidecar.request', { name: 'n' }, { class: 'io', cids: [cid] });
  const debugOn = (seq) => event(seq, 'log.policy', { source: 'file', classes: { lifecycle: 'trace', input: 'trace', call: 'trace', io: 'trace', frame: 'trace' } });
  const { folder, config } = fixture(t, {
    files: {
      'host-0-1.jsonl': [open('host', '0-1'), debugOn(2), request(3, 'c-old')],
      [`host-${BOOT}.jsonl`]: [open('host', BOOT, 10), debugOn(11), start(12, 't1'), request(13, 'c-new'), end(14, 't1')],
    },
    marks: (mark) => [mark({ kind: 'start', boot: BOOT, seq: 12 }), mark({ kind: 'end', boot: BOOT, seq: 14 })],
  });
  assert.deepEqual(auditRun(chained, folder), [`${join(config, 'logs', `host-${BOOT}.jsonl`)}:4: chain input of c-new lacks host.update.start`]);
});

test('a class that stores more events or bytes per minute than its budget over a run of a minute or more is a finding, and the judgment holds the volume of each class', (t) => {
  // Three lifecycle events in the span of 90 s between the marks are 2 events per minute.
  const tight = { ...catalog, budget: { ...catalog.budget, lifecycle: { events: 1, bytes: 100000000 } } };
  const late = (seq, name) => event(seq, 'host.test.end', { name, run: 'run-1', result: 'pass' }, { ts_us: US + 2000 + 90_000_000 });
  const { folder, config } = fixture(t, {
    files: { [`host-${BOOT}.jsonl`]: [open('host', BOOT), start(2, 't1'), focus(3), late(4, 't1')] },
    marks: (mark) => [mark({ kind: 'start', boot: BOOT, seq: 2 }), mark({ kind: 'end', boot: BOOT, seq: 4 })],
  });
  const findings = auditRun(tight, folder);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /marks\.jsonl:1: the class lifecycle of .+ stored 2 events per minute, above its budget of 1/);
  const volume = judgment(folder).volume;
  assert.deepEqual(volume.map(({ config: folderOf, classes }) => [folderOf, Object.keys(classes)]), [[config, ['lifecycle']]]);
  assert.equal(volume[0].classes.lifecycle.events, 3);
  assert.equal(volume[0].minutes, 1.5);
});

test('a run shorter than a minute records the volume of each class without judging it against the budget', (t) => {
  // Three lifecycle events in 2 ms are 90000 events per minute, a rate of a burst and not of a minute.
  const tight = { ...catalog, budget: { ...catalog.budget, lifecycle: { events: 1000, bytes: 100000000 } } };
  const { folder } = fixture(t, {
    files: { [`host-${BOOT}.jsonl`]: [open('host', BOOT), start(2, 't1'), focus(3), end(4, 't1')] },
    marks: (mark) => [mark({ kind: 'start', boot: BOOT, seq: 2 }), mark({ kind: 'end', boot: BOOT, seq: 4 })],
  });
  assert.deepEqual(auditRun(tight, folder), []);
  assert.equal(judgment(folder).volume[0].classes.lifecycle.eventsPerMinute, 90000);
});

test('a catalog without a budget, or a class of a run that the budget does not name, is refused or a finding', (t) => {
  const { folder } = fixture(t, {
    files: { [`host-${BOOT}.jsonl`]: [open('host', BOOT), start(2, 't1'), end(3, 't1')] },
    marks: (mark) => [mark({ kind: 'start', boot: BOOT, seq: 2 }), mark({ kind: 'end', boot: BOOT, seq: 3 })],
  });
  const { budget, ...none } = catalog;
  assert.throws(() => auditRun(none, folder), /the catalog declares no budget/);
  const partial = { ...catalog, budget: { io: budget.io } };
  assert.match(auditRun(partial, folder)[0], /the class lifecycle of .+ has no budget/);
});

test('the logs of every layer under the configuration folders of the marks are audited, and a sidecar error is placed by time', (t) => {
  const sidecar = (seq, text, offset) => JSON.stringify({ ts_us: US + offset, mono_ns: 7_000_000_000 + offset * 1000, seq, level: 'error', class: 'lifecycle', layer: 'sidecar', event: 'sidecar.record.error', fields: { where: 'vt', text } });
  const { folder, config } = fixture(t, {
    files: {
      [`host-${BOOT}.jsonl`]: [open('host', BOOT), start(2, 't1'), event(3, 'host.window.event', { window: 'w' }), end(4, 't1')],
      // The error at 99 ms is after the last end mark of the run, so the run does not judge it.
      'vt-3-4.jsonl': [open('vt', '3-4'), sidecar(2, 'inside', 2500), sidecar(3, 'late', 99000)],
    },
    marks: (mark) => [mark({ kind: 'start', boot: BOOT, seq: 2 }), mark({ kind: 'end', boot: BOOT, seq: 4 })],
  });
  const vt = join(config, 'logs', 'vt-3-4.jsonl');
  assert.deepEqual(auditRun(catalog, folder), [
    `${join(config, 'logs', `host-${BOOT}.jsonl`)}:3: field kind is required by host.window.event`,
    `${vt}:2: undeclared error vt: inside`,
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

test('the events of a sidecar installed in a configuration folder of the run are audited against its catalog', (t) => {
  const alpha = JSON.parse(readFileSync(new URL('../../packages/log-contract/fixtures/extension/alpha.json', import.meta.url), 'utf8'));
  const { folder, config } = fixture(t, {
    files: {
      [`host-${BOOT}.jsonl`]: [open('host', BOOT), start(2, 't1'), end(3, 't1')],
      'alpha-3-4.jsonl': [open('alpha', '3-4'), event(2, 'sidecar.alpha.start', { pid: 3 }, { layer: 'sidecar' }), event(3, 'sidecar.alpha.surprise', {}, { layer: 'sidecar' })],
    },
    marks: (mark) => [mark({ kind: 'start', boot: BOOT, seq: 2 }), mark({ kind: 'end', boot: BOOT, seq: 3 })],
  });
  const path = 'sidecars/alpha/1.0.0/platform';
  mkdirSync(join(config, 'plugins'));
  mkdirSync(join(config, path), { recursive: true });
  writeFileSync(join(config, 'plugins', 'installed.json'), JSON.stringify({ format: 2, plugins: {}, sidecars: { alpha: { version: '1.0.0', path } } }));
  writeFileSync(join(config, path, 'sidecar.json'), JSON.stringify({ executable: 'bin/alpha', protocol: 1, events: 'events.json' }));
  writeFileSync(join(config, path, 'events.json'), JSON.stringify(alpha));
  assert.deepEqual(auditRun(catalog, folder), [`${join(config, 'logs', 'alpha-3-4.jsonl')}:3: event sidecar.alpha.surprise is not declared`]);
});

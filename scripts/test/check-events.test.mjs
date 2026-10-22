import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { auditLogDirectories, catalogOf, installedSidecarCatalogs } from '../check-events.mjs';

const catalog = {
  schema: 2,
  layers: ['host', 'page'],
  events: {
    'log.open': { layer: 'host', class: 'lifecycle', level: 'info', fields: { schema: 'number', pid: 'number', role: 'string', boot: 'string' } },
    'host.window.event': { layer: 'host', class: 'lifecycle', level: 'info', fields: { window: 'string', kind: 'string' } },
    'page.record.<level>': { layer: 'page', class: 'lifecycle', level: ['error', 'info'], fields: { where: 'string', text: 'string' } },
  },
};

test('the logs of a configuration folder are audited against the catalog and the findings name the file and the line', () => {
  const root = mkdtempSync(join(tmpdir(), 'events-'));
  mkdirSync(join(root, 'logs'));
  const line = (seq, event, fields, layer = 'host') => JSON.stringify({ ts_us: 1000 + seq, mono_ns: 5_000_000 + seq, seq, level: 'info', class: 'lifecycle', layer, event, fields });
  writeFileSync(join(root, 'logs', 'host-1-2.jsonl'), [
    line(1, 'log.open', { schema: 2, pid: 2, role: 'host', boot: '1-2' }),
    line(2, 'host.window.event', { window: 'main', kind: 'focus' }),
    line(3, 'host.window.event', { window: 'main' }),
    line(4, 'host.surprise', {}),
  ].join('\n') + '\n');
  assert.deepEqual(auditLogDirectories({ ...catalog, layers: [...catalog.layers, 'sidecar'] }, [root]), [
    `${join(root, 'logs', 'host-1-2.jsonl')}:3: field kind is required by host.window.event`,
    `${join(root, 'logs', 'host-1-2.jsonl')}:4: event host.surprise is not declared`,
  ]);
  assert.throws(() => auditLogDirectories(catalog, [join(root, 'missing')]), /missing\/logs: ENOENT/);
  mkdirSync(join(root, 'empty', 'logs'), { recursive: true });
  assert.throws(() => auditLogDirectories(catalog, [join(root, 'empty')]), /empty\/logs: no host event file/);
});
test('the audit of a configuration folder reads the files of every layer, generation and the debug file, and reports an error event', () => {
  const root = mkdtempSync(join(tmpdir(), 'events-'));
  mkdirSync(join(root, 'logs'));
  const line = (seq, event, fields, extra = {}) => JSON.stringify({ ts_us: 1000 + seq, mono_ns: 5_000_000 + seq, seq, level: 'info', class: 'lifecycle', layer: 'host', event, fields, ...extra });
  const open = (seq, role) => line(seq, 'log.open', { schema: 2, pid: 2, role, boot: '1-2' });
  const write = (name, lines) => writeFileSync(join(root, 'logs', name), `${lines.join('\n')}\n`);
  // The generations are numbered in the order of the rotations without an upper bound: the debug file has the generation 10.
  write('host-1-2.jsonl.1', [open(1, 'host'), line(2, 'host.window.event', { window: 'main', kind: 'focus' })]);
  write('host-1-2.jsonl', [open(3, 'host'), line(5, 'page.record.error', { where: 'w', text: 't' }, { layer: 'page', page: '1791948729050', level: 'error' })]);
  write('host-1-2.debug.jsonl.10', [open(4, 'host'), line(6, 'host.window.event', { window: 'main', kind: 'focus' }, { level: 'debug' })]);
  write('probe-3-4.jsonl', [open(1, 'probe'), line(2, 'host.surprise', {}, { layer: 'sidecar' })]);
  write('notes.txt', ['not an event file']);
  const logs = join(root, 'logs');
  assert.deepEqual(auditLogDirectories({ ...catalog, layers: [...catalog.layers, 'sidecar'] }, [root]), [
    `${join(logs, 'host-1-2.jsonl')}:2: undeclared error w: t`,
    `${join(logs, 'probe-3-4.jsonl')}:2: event host.surprise is not declared`,
  ]);
});

test('the catalog declares the chain of each operation of the page and the first event of each requires identifiers', () => {
  const real = JSON.parse(readFileSync(new URL('../../docs/spec/events.json', import.meta.url), 'utf8'));
  const first = { plugin: 'page.plugin.operation', project: 'page.project.operation', window: 'page.window.operation', settings: 'page.settings.change', update: 'page.update.operation' };
  for (const [chain, event] of Object.entries(first)) {
    // The close of a window ends its page before the page records the completion of the call (docs/spec/logging.md#operation-chains).
    const call = chain === 'window' ? [] : ['page.call'];
    assert.deepEqual(real.chains[chain], [event, ...call, 'host.binding.call'], chain);
    assert.equal(real.events[event].cids, 'required', event);
    assert.equal(real.events[event].layer, 'page', event);
  }
  assert.deepEqual(real.events['page.settings.change'].fields, { scope: 'string', actor: 'string', keys: 'string' });
  assert.deepEqual(real.events['page.plugin.operation'].fields, { action: 'string', plugin: 'string' });
  assert.deepEqual(real.events['page.project.operation'].fields, { action: 'string', project: 'string' });
  assert.deepEqual(real.events['page.window.operation'].fields, { action: 'string' });
  assert.deepEqual(real.events['page.update.operation'].fields, { action: 'string', version: 'string' });
});

const alphaCatalog = JSON.parse(readFileSync(new URL('../../docs/spec/cases/log-contract/extension/alpha.json', import.meta.url), 'utf8'));
const SIDECAR_PATH = 'sidecars/alpha/1.0.0/platform';

/** A configuration folder that has installed the sidecar `alpha`, whose `sidecar.json` names the catalog `events.json`. */
function installed(t, { sidecar = { executable: 'bin/alpha', protocol: 1, events: 'events.json' }, catalog = alphaCatalog, format = 3 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'events-'));
  t.after(() => rmSync(root, { recursive: true }));
  mkdirSync(join(root, 'plugins'));
  mkdirSync(join(root, SIDECAR_PATH), { recursive: true });
  writeFileSync(join(root, 'plugins', 'installed.json'), JSON.stringify({ format, plugins: {}, sidecars: { alpha: { version: '1.0.0', path: SIDECAR_PATH } } }));
  writeFileSync(join(root, SIDECAR_PATH, 'sidecar.json'), JSON.stringify(sidecar));
  if (catalog !== null) writeFileSync(join(root, SIDECAR_PATH, 'events.json'), JSON.stringify(catalog));
  mkdirSync(join(root, 'logs'));
  return root;
}

test('the catalogs of the installed sidecars are read from the folders that installed.json records, through the member events of sidecar.json', (t) => {
  const root = installed(t);
  assert.deepEqual(installedSidecarCatalogs(root), [alphaCatalog]);
  const none = mkdtempSync(join(tmpdir(), 'events-'));
  t.after(() => rmSync(none, { recursive: true }));
  assert.deepEqual(installedSidecarCatalogs(none), []);
  const bare = installed(t, { sidecar: { executable: 'bin/alpha', protocol: 1 }, catalog: null });
  assert.deepEqual(installedSidecarCatalogs(bare), []);
});

test('an installed sidecar whose record or catalog cannot be read is an error that names the file', (t) => {
  assert.throws(() => installedSidecarCatalogs(installed(t, { format: 1 })), /plugins\/installed\.json: format must be 3/);
  assert.throws(() => installedSidecarCatalogs(installed(t, { catalog: null })), /platform\/events\.json: the event catalog of the sidecar alpha: ENOENT/);
  assert.throws(() => catalogOf(catalog, installed(t, { catalog: { ...alphaCatalog, sidecar: undefined } })), /the member sidecar must name the sidecar/);
});

test('the events of an installed sidecar are audited against its catalog, and a chain extension finds a request that the sidecar did not follow', (t) => {
  const root = installed(t);
  const base = { schema: 2, layers: ['host', 'sidecar'], chains: { input: ['host.sidecar.request'] },
    events: {
      'log.open': alphaCatalog.events['log.open'],
      'host.sidecar.request': { layer: 'host', class: 'io', level: 'info', cids: 'required', fields: { name: 'string' } },
    } };
  // Every line states the class that the catalog declares for its event; an undeclared event has none.
  const classOf = (event) => (base.events[event] ?? alphaCatalog.events[event])?.class;
  const line = (seq, event, fields, layer, extra = {}) => JSON.stringify({ ts_us: 1000 + seq, mono_ns: 5_000_000 + seq, seq, level: 'info', ...(classOf(event) === undefined ? {} : { class: classOf(event) }), layer, event, fields, ...extra });
  writeFileSync(join(root, 'logs', 'host-1-2.jsonl'), [
    line(1, 'log.open', { schema: 2, pid: 2, role: 'host', boot: '1-2' }, 'sidecar'),
    line(2, 'host.sidecar.request', { name: 'alpha' }, 'host', { cids: ['1-2.1'] }),
  ].join('\n') + '\n');
  writeFileSync(join(root, 'logs', 'alpha-3-4.jsonl'), [
    line(1, 'log.open', { schema: 2, pid: 3, role: 'alpha', boot: '3-4' }, 'sidecar'),
    line(2, 'sidecar.alpha.start', { pid: 3 }, 'sidecar'),
    line(3, 'sidecar.alpha.surprise', {}, 'sidecar'),
  ].join('\n') + '\n');
  const logs = join(root, 'logs');
  assert.deepEqual(auditLogDirectories(base, [root]), [
    `${join(logs, 'alpha-3-4.jsonl')}:3: event sidecar.alpha.surprise is not declared`,
    `${join(logs, 'host-1-2.jsonl')}:2: chain input of 1-2.1 lacks sidecar.alpha.write after host.sidecar.request of alpha`,
  ]);
});

test('a host stall record at warn that the gate exception stores is not an audit finding', () => {
  const root = mkdtempSync(join(tmpdir(), 'events-'));
  mkdirSync(join(root, 'logs'));
  const line = (seq, event, fields, level = 'info') => JSON.stringify({ ts_us: 1000 + seq, mono_ns: 5_000_000 + seq, seq, level, class: 'lifecycle', layer: 'host', event, fields });
  const stall = {
    ...catalog,
    events: {
      ...catalog.events,
      'host.stall': { layer: 'host', class: 'lifecycle', level: 'warn', fields: { late_ms: 'number' } },
      'host.stall.sampled': { layer: 'host', class: 'lifecycle', level: 'warn', fields: { path: 'string', 'error?': 'string' } },
    },
  };
  writeFileSync(join(root, 'logs', 'host-1-2.jsonl'), [
    line(1, 'log.open', { schema: 2, pid: 2, role: 'host', boot: '1-2' }),
    line(2, 'host.stall', { late_ms: 1200 }, 'warn'),
    line(3, 'host.stall.sampled', { path: '/logs/stall-host-2-3.txt' }, 'warn'),
  ].join('\n') + '\n');
  assert.deepEqual(auditLogDirectories(stall, [root]), []);
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { auditLogDirectories } from '../check-events.mjs';

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
  write('host-1-2.jsonl', [open(3, 'host'), line(5, 'page.record.error', { where: 'w', text: 't' }, { layer: 'page', level: 'error' })]);
  write('host-1-2.debug.jsonl.10', [open(4, 'host'), line(6, 'host.window.event', { window: 'main', kind: 'focus' }, { level: 'debug' })]);
  write('vt-3-4.jsonl', [open(1, 'vt'), line(2, 'host.surprise', {}, { layer: 'sidecar' })]);
  write('notes.txt', ['not an event file']);
  const logs = join(root, 'logs');
  assert.deepEqual(auditLogDirectories({ ...catalog, layers: [...catalog.layers, 'sidecar'] }, [root]), [
    `${join(logs, 'host-1-2.jsonl')}:2: undeclared error w: t`,
    `${join(logs, 'vt-3-4.jsonl')}:2: event host.surprise is not declared`,
  ]);
});

test('the catalog declares the chain of each operation of the page and the first event of each requires identifiers', () => {
  const real = JSON.parse(readFileSync(new URL('../../docs/spec/events.json', import.meta.url), 'utf8'));
  const first = { plugin: 'page.plugin.operation', project: 'page.project.operation', window: 'page.window.operation', settings: 'page.settings.change', update: 'page.update.operation' };
  for (const [chain, event] of Object.entries(first)) {
    assert.deepEqual(real.chains[chain], [event, 'page.call', 'host.binding.call'], chain);
    assert.equal(real.events[event].cids, 'required', event);
    assert.equal(real.events[event].layer, 'page', event);
  }
  assert.deepEqual(real.events['page.settings.change'].fields, { scope: 'string', actor: 'string', keys: 'string' });
  assert.deepEqual(real.events['page.plugin.operation'].fields, { action: 'string', plugin: 'string' });
  assert.deepEqual(real.events['page.project.operation'].fields, { action: 'string', project: 'string' });
  assert.deepEqual(real.events['page.window.operation'].fields, { action: 'string' });
  assert.deepEqual(real.events['page.update.operation'].fields, { action: 'string', version: 'string' });
});

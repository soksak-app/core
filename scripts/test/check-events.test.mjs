import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { auditLogDirectories } from '../check-events.mjs';

const catalog = {
  schema: 1,
  layers: ['host', 'page'],
  events: {
    'log.open': { layer: 'host', class: 'lifecycle', level: 'info', fields: { schema: 'number', pid: 'number', role: 'string', boot: 'string' } },
    'host.window.event': { layer: 'host', class: 'lifecycle', level: 'info', fields: { window: 'string', kind: 'string' } },
  },
};

test('the logs of a configuration folder are audited against the catalog and the findings name the file and the line', () => {
  const root = mkdtempSync(join(tmpdir(), 'events-'));
  mkdirSync(join(root, 'logs'));
  const line = (seq, event, fields, layer = 'host') => JSON.stringify({ ts_us: 1000 + seq, seq, level: 'info', layer, event, fields });
  writeFileSync(join(root, 'logs', 'host-1-2.jsonl'), [
    line(1, 'log.open', { schema: 1, pid: 2, role: 'host', boot: '1-2' }),
    line(2, 'host.window.event', { window: 'main', kind: 'focus' }),
    line(3, 'host.window.event', { window: 'main' }),
    line(4, 'host.surprise', {}),
  ].join('\n') + '\n');
  assert.deepEqual(auditLogDirectories(catalog, [root]), [
    `${join(root, 'logs', 'host-1-2.jsonl')}:3: field kind is required by host.window.event`,
    `${join(root, 'logs', 'host-1-2.jsonl')}:4: event host.surprise is not declared`,
  ]);
  assert.throws(() => auditLogDirectories(catalog, [join(root, 'missing')]), /missing\/logs: ENOENT/);
  mkdirSync(join(root, 'empty', 'logs'), { recursive: true });
  assert.throws(() => auditLogDirectories(catalog, [join(root, 'empty')]), /empty\/logs: no host event file/);
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as checker from '../check-events.mjs';
import { auditLogDirectories } from '../check-events.mjs';

const catalog = {
  schema: 1,
  layers: ['host', 'page'],
  events: {
    'log.open': { layer: 'host', class: 'lifecycle', level: 'info', fields: { schema: 'number', pid: 'number', role: 'string', boot: 'string' } },
    'host.window.event': { layer: 'host', class: 'lifecycle', level: 'info', fields: { window: 'string', kind: 'string' } },
    'page.record.<level>': { layer: 'page', class: 'lifecycle', level: ['error', 'info'], fields: { where: 'string', text: 'string' } },
    'host.never.emitted': { layer: 'host', class: 'lifecycle', level: 'info', fields: {} },
  },
};

/** The findings of the sources that are not about the declared-without-site rule. */
const sitesOnly = (findings) => findings.filter((finding) => !finding.includes('is declared and no source emits it'));

test('an emit with a literal name that the catalog does not declare is a finding with its file and line, in every language', () => {
  const sources = new Map([
    ['a.go', 'package host\n\nfunc f() {\n\tEmitHost(LevelInfo, "host.surprise.go", nil)\n}\n'],
    ['b.rs', 'fn f() {\n    crate::event_record::emit_host(\n        Level::Info,\n        "host.surprise.rs",\n        serde_json::json!({}),\n    );\n}\n'],
    ['c.js', 'export function f() {\n  emitEvent("info", "page.surprise.js", {});\n}\n'],
    ['d.m', 'void f(void) {\n    sp_event(SP_EVENT_INFO, "native.surprise.m", "{}");\n}\n'],
  ]);
  assert.deepEqual(sitesOnly(checker.emitFindings(catalog, sources)), [
    'a.go:4: host.surprise.go is emitted and docs/spec/events.json does not declare it',
    'b.rs:4: host.surprise.rs is emitted and docs/spec/events.json does not declare it',
    'c.js:2: page.surprise.js is emitted and docs/spec/events.json does not declare it',
    'd.m:2: native.surprise.m is emitted and docs/spec/events.json does not declare it',
  ]);
});

test('a declared event is found only at an emit site: its name in a comment, a string or a definition is not a site', () => {
  const sources = new Map([
    ['a.go', '// EmitHost(LevelInfo, "host.never.emitted", nil)\nvar text = "EmitHost(LevelInfo, \\"host.never.emitted\\", nil)"\nfunc EmitHost(level Level, event string, fields map[string]any) {}\n'],
    ['b.js', 'const name = "host.never.emitted";\nemitEvent("info", "host.window.event", { window, kind });\n'],
  ]);
  assert.deepEqual(checker.emitFindings(catalog, sources), [
    'docs/spec/events.json: log.open is declared and no source emits it',
    'docs/spec/events.json: page.record.<level> is declared and no source emits it',
    'docs/spec/events.json: host.never.emitted is declared and no source emits it',
  ]);
});

test('a family is emitted by a concrete name, by a template name and by a marker', () => {
  const family = { ...catalog, events: { ...catalog.events, 'host.trace.<event>': { layer: 'host', class: 'call', level: 'debug', fields: {} } } };
  const sources = new Map([
    ['a.go', 'func f() {\n\tEmitHost(LevelDebug, "host.trace.frame", map[string]any{})\n\tEmitHost(LevelInfo, "host.window.event", map[string]any{"window": w, "kind": k})\n}\n'],
    ['b.js', 'batcher.emit("info", `page.record.${level}`, { where, text });\n'],
    ['c.go', 'func g() {\n\t// events: host.never.emitted\n\tstoreEvent(level, layer, layer+".never.emitted", "p", fields)\n}\n'],
    ['d.go', 'var open = pendingEvent{level: LevelInfo, event: "log.open", fields: fields}\n'],
  ]);
  assert.deepEqual(checker.emitFindings(family, sources), []);
  sources.delete('b.js');
  assert.deepEqual(checker.emitFindings(family, sources), ['docs/spec/events.json: page.record.<level> is declared and no source emits it']);
});

test('a name that a site builds needs a marker `events: <names>` above it, and a marker needs a site', () => {
  const own = (sources) => sitesOnly(checker.emitFindings(catalog, new Map(sources)));
  assert.deepEqual(own([['a.go', 'func f() {\n\tstoreEvent(level, layer, layer+".x", "p", fields)\n}\n']]), [
    'a.go:2: the name of this emit is not a literal; write a comment `events: <declared names>` above it, or `events: forwarded` when it passes the name of its caller',
  ]);
  assert.deepEqual(own([['a.go', 'func f() {\n\t// events: forwarded\n\tstoreEvent(level, layer, name, "p", fields)\n}\n']]), []);
  assert.deepEqual(own([['a.go', 'func f() {\n\t// events: host.unknown\n\tstoreEvent(level, layer, layer+".x", "p", fields)\n}\n']]), [
    'a.go:2: host.unknown is named by a marker and docs/spec/events.json does not declare it',
  ]);
  assert.deepEqual(own([['a.go', '// events: host.window.event\nfunc f() {}\n']]), [
    'a.go:1: this marker is not above an emit whose name is built',
  ]);
});

test('the level and the fields of a literal site must match the declaration', () => {
  const optional = { ...catalog, events: { ...catalog.events, 'page.optional': { layer: 'page', class: 'call', level: ['debug', 'warn'], fields: { name: 'string', 'error?': 'string' } } } };
  const sources = new Map([
    ['a.go', 'func f() {\n\tEmitHost(LevelError, "host.window.event", map[string]any{"window": w})\n\tEmitHost(LevelInfo, "host.window.event", map[string]any{"window": w, "kind": k, "extra": 1})\n}\n'],
    ['b.rs', 'fn f() {\n    emit_host(\n        Level::Warn,\n        "host.window.event",\n        json!({"window": w, "kind": k}),\n    );\n}\n'],
    ['c.js', 'emitEvent("debug", "page.optional", { name, ...rest });\nemitEvent("warn", "page.optional", { name, error });\nemitEvent("info", "page.optional", { error });\n'],
  ]);
  assert.deepEqual(sitesOnly(checker.emitFindings(optional, sources)), [
    'a.go:2: host.window.event is emitted at the level error and the catalog declares info',
    'a.go:2: host.window.event lacks the field kind that the catalog requires',
    'a.go:3: host.window.event has the field extra, which the catalog does not declare',
    'b.rs:4: host.window.event is emitted at the level warn and the catalog declares info',
    'c.js:3: page.optional is emitted at the level info and the catalog declares debug, warn',
    'c.js:3: page.optional lacks the field name that the catalog requires',
  ]);
});

test('an entry of the catalog with a layer, class, level or field type outside the contract is a finding', () => {
  const broken = { schema: 1, layers: ['host'], events: {
    'host.a': { layer: 'host', class: 'lifecycle', level: 'info', fields: { 'x?': 'string|null' } },
    'host.b': { layer: 'host', class: 'sometimes', level: 'info', fields: {} },
    'host.c': { layer: 'host', class: 'lifecycle', level: ['info', 'loud'], fields: {} },
    'page.d': { layer: 'page', class: 'lifecycle', level: 'info', fields: {} },
    'host.e': { layer: 'host', class: 'lifecycle', level: 'info', fields: { x: 'text' } },
  } };
  assert.deepEqual(checker.catalogFindings(broken), [
    'docs/spec/events.json: host.b has the class sometimes, which is not one of lifecycle, input, call, io, frame',
    'docs/spec/events.json: host.c has the level loud, which is not one of error, warn, info, debug, trace',
    'docs/spec/events.json: page.d has the layer page, which the catalog does not list',
    'docs/spec/events.json: host.e has the field x of type text, which is not string, number, boolean, array, object or null',
  ]);
});

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
  assert.deepEqual(auditLogDirectories({ ...catalog, layers: [...catalog.layers, 'sidecar'] }, [root]), [
    `${join(root, 'logs', 'host-1-2.jsonl')}:3: field kind is required by host.window.event`,
    `${join(root, 'logs', 'host-1-2.jsonl')}:4: event host.surprise is not declared`,
  ]);
  assert.throws(() => auditLogDirectories(catalog, [join(root, 'missing')]), /missing\/logs: ENOENT/);
  mkdirSync(join(root, 'empty', 'logs'), { recursive: true });
  assert.throws(() => auditLogDirectories(catalog, [join(root, 'empty')]), /empty\/logs: no host event file/);
});

test('the placed variants of the host emit functions are emit sites, and a built name takes its declared names from the marker above', () => {
  const sources = new Map([
    ['a.go', 'package host\n\nfunc f(event string) {\n\t// events: host.window.event\n\tEmitHostPlaced(LevelInfo, event, nil, 0)\n\tEmitHostPlaced(LevelInfo, "host.surprise.go", nil, 0)\n}\n'],
    ['b.rs', 'fn f(event: &str) {\n    // events: host.never.emitted\n    emit_host_placed(Level::Info, event, fields, deadline);\n    emit_host_placed(Level::Info, "host.surprise.rs", fields, deadline);\n}\n'],
  ]);
  assert.deepEqual(checker.emitFindings(catalog, sources).filter((finding) => !finding.includes('is declared and no source emits it')), [
    'a.go:6: host.surprise.go is emitted and docs/spec/events.json does not declare it',
    'b.rs:4: host.surprise.rs is emitted and docs/spec/events.json does not declare it',
  ]);
});

test('the audit of a configuration folder reads the files of every layer, generation and the debug file, and reports an error event', () => {
  const root = mkdtempSync(join(tmpdir(), 'events-'));
  mkdirSync(join(root, 'logs'));
  const line = (seq, event, fields, extra = {}) => JSON.stringify({ ts_us: 1000 + seq, seq, level: 'info', layer: 'host', event, fields, ...extra });
  const open = (seq, role) => line(seq, 'log.open', { schema: 1, pid: 2, role, boot: '1-2' });
  const write = (name, lines) => writeFileSync(join(root, 'logs', name), `${lines.join('\n')}\n`);
  write('host-1-2.jsonl.1', [open(1, 'host'), line(2, 'host.window.event', { window: 'main', kind: 'focus' })]);
  write('host-1-2.jsonl', [open(3, 'host'), line(5, 'host.window.event', { window: 'main', kind: 'focus' })]);
  write('host-1-2.debug.jsonl', [open(4, 'host'), line(6, 'page.record.error', { where: 'w', text: 't' }, { layer: 'page', level: 'error' })]);
  write('vt-3-4.jsonl', [open(1, 'vt'), line(2, 'host.surprise', {}, { layer: 'sidecar' })]);
  write('notes.txt', ['not an event file']);
  const logs = join(root, 'logs');
  assert.deepEqual(auditLogDirectories({ ...catalog, layers: [...catalog.layers, 'sidecar'] }, [root]), [
    `${join(logs, 'host-1-2.debug.jsonl')}:2: undeclared error w: t`,
    `${join(logs, 'vt-3-4.jsonl')}:2: event host.surprise is not declared`,
  ]);
});

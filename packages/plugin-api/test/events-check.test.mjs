import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import * as checker from '../events-check.js';

const CATALOG = 'docs/spec/events.json';
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
  assert.deepEqual(sitesOnly(checker.emitFindings(catalog, sources, CATALOG)), [
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
  assert.deepEqual(checker.emitFindings(catalog, sources, CATALOG), [
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
  assert.deepEqual(checker.emitFindings(family, sources, CATALOG), []);
  sources.delete('b.js');
  assert.deepEqual(checker.emitFindings(family, sources, CATALOG), ['docs/spec/events.json: page.record.<level> is declared and no source emits it']);
});

test('a name that a site builds needs a marker `events: <names>` above it, and a marker needs a site', () => {
  const own = (sources) => sitesOnly(checker.emitFindings(catalog, new Map(sources), CATALOG));
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
  assert.deepEqual(sitesOnly(checker.emitFindings(optional, sources, CATALOG)), [
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
  assert.deepEqual(checker.catalogFindings(broken, CATALOG), [
    'docs/spec/events.json: host.b has the class sometimes, which is not one of lifecycle, input, call, io, frame',
    'docs/spec/events.json: host.c has the level loud, which is not one of error, warn, info, debug, trace',
    'docs/spec/events.json: page.d has the layer page, which the catalog does not list',
    'docs/spec/events.json: host.e has the field x of type text, which is not string, number, boolean, array, object or null',
  ]);
});

test('the placed variants of the host emit functions are emit sites, and a built name takes its declared names from the marker above', () => {
  const sources = new Map([
    ['a.go', 'package host\n\nfunc f(event string) {\n\t// events: host.window.event\n\tEmitHostPlaced(LevelInfo, event, nil, 0)\n\tEmitHostPlaced(LevelInfo, "host.surprise.go", nil, 0)\n}\n'],
    ['b.rs', 'fn f(event: &str) {\n    // events: host.never.emitted\n    emit_host_placed(Level::Info, event, fields, deadline);\n    emit_host_placed(Level::Info, "host.surprise.rs", fields, deadline);\n}\n'],
  ]);
  assert.deepEqual(checker.emitFindings(catalog, sources, CATALOG).filter((finding) => !finding.includes('is declared and no source emits it')), [
    'a.go:6: host.surprise.go is emitted and docs/spec/events.json does not declare it',
    'b.rs:4: host.surprise.rs is emitted and docs/spec/events.json does not declare it',
  ]);
});

const EVENT_RULES = checker.censusRules();
const noConfig = () => checker.parseCensusConfig('census.json', '{}');
const census = (files, config = noConfig()) => checker.censusFindings(new Map(Object.entries(files)), config)
  .map(({ file, line, rule }) => `${file}:${line} ${rule}`);

test('a source of occurrences with neither an event in its function nor a reason marker is a finding of its language rule', () => {
  assert.deepEqual(census({
    'a.js': 'export function f() {\n  try { g(); } catch (error) {}\n  p.catch(() => {});\n}\n',
    'b.rs': 'fn f() {\n    let n = text.parse::<u32>().ok();\n    let v = x.unwrap_or(0);\n    let _ = sender.send(1);\n}\n',
    'c.go': 'package a\n\nfunc f() {\n\tgo run()\n\tgo func() {\n\t\tdefer func() { recover() }()\n\t}()\n}\n',
    'd.m': '- (BOOL)f {\n    [center addObserverForName:n object:nil queue:nil usingBlock:^(NSNotification *x) {}];\n    window.delegate = self;\n    return NO;\n}\n',
  }), [
    'a.js:2 js.empty-catch', 'a.js:3 js.swallowing-catch',
    'b.rs:2 rs.ok-discard', 'b.rs:3 rs.unwrap-or', 'b.rs:4 rs.dropped-send',
    'c.go:4 go.go-statement', 'c.go:5 go.go-statement', 'c.go:6 go.recover',
    'd.m:2 m.registration', 'd.m:3 m.delegate', 'd.m:4 m.error-return',
  ]);
});

test('the message of a finding names the file, the line and the rule', () => {
  const [finding] = checker.censusFindings(new Map([['a/b.rs', 'fn f() {\n    x.unwrap_or(1);\n}\n']]), noConfig());
  assert.equal(finding.message, 'a/b.rs:2: rs.unwrap-or has neither an event nor a stated reason');
  const [outside] = checker.censusFindings(new Map([['a.go', 'package a\n\nfunc f() {\n\tgo run()\n}\n']]), noConfig());
  assert.equal(outside.message, 'a.go:4: go.go-statement is outside its entrance files');
});

test('a reason marker on the line, in the comment above it or inside an empty catch accepts a source', () => {
  assert.deepEqual(census({
    'a.js': [
      'export function f() {',
      '  try { g(); } catch (error) { /* silent: g only warms a cache that is rebuilt on use. */ }',
      '  // silent: the listener may have been removed by then.',
      '  p.catch(() => {});',
      '  try {',
      '    h();',
      '  } catch {',
      '    // silent: h is optional and its absence is the expected state.',
      '  }',
      '}',
    ].join('\n'),
    'b.rs': 'fn f() {\n    // default: a missing count means zero for the declared total.\n    let v = x.unwrap_or(0);\n}\n',
  }), []);
  assert.deepEqual(census({ 'a.js': 'export function f() {\n  // a note without a marker\n  try { g(); } catch (error) {}\n}\n' }), ['a.js:3 js.empty-catch']);
  assert.deepEqual(census({ 'a.js': 'export function f() {\n  try { g(); } catch (error) {} // silent: short\n}\n' }), ['a.js:2 js.empty-catch']);
});

test('an event in the function of a source accepts it, and an event in another function does not', () => {
  assert.deepEqual(census({
    'a.rs': 'fn f() {\n    let n = text.parse::<u32>().ok();\n    emit_host(Level::Warn, "host.window.event", json!({}));\n}\n',
    'b.go': 'package a\n\nfunc f() {\n\tif err != nil {\n\t\tEmitHost(LevelWarn, "host.window.event", nil)\n\t}\n}\n',
    'c.js': 'export const f = () => {\n  try { g(); } catch (error) {\n    emitEvent("warn", "page.record.warn", {});\n  }\n};\n',
    'd.m': '- (BOOL)f {\n    dispatch_async(q, ^{\n        sp_event(SP_EVENT_WARN, "native.x", "{}");\n    });\n    return NO;\n}\n',
  }), []);
  assert.deepEqual(census({
    'a.rs': 'fn f() {\n    emit_host(Level::Warn, "host.window.event", json!({}));\n}\n\nfn g() {\n    let n = text.parse::<u32>().ok();\n}\n',
    'b.go': 'package a\n\nfunc f() {\n\tEmitHost(LevelWarn, "host.window.event", nil)\n}\n\nfunc (r *R) g() {\n\tgo r.run()\n}\n',
    'c.js': 'export const f = () => { emitEvent("warn", "page.record.warn", {}); };\nexport const g = () => {\n  try { h(); } catch (error) {}\n};\n',
    'd.m': '- (BOOL)f {\n    sp_event(SP_EVENT_WARN, "native.x", "{}");\n    return YES;\n}\n- (BOOL)g {\n    return NO;\n}\n',
  }), ['a.rs:6 rs.ok-discard', 'b.go:8 go.go-statement', 'c.js:3 js.empty-catch', 'd.m:6 m.error-return']);
});

test('a source in a comment or a string is not a finding, and an entrance file may hold its rule', () => {
  assert.deepEqual(census({ 'a.rs': '// x.unwrap_or(0)\nfn f() { let s = "y.ok()"; }\n' }), []);
  const config = checker.parseCensusConfig('census.json', JSON.stringify({ entrances: { 'go.go-statement': ['^spawn\\.go$'], 'go.recover': ['^spawn\\.go$'] } }));
  const entrance = 'package a\n\nfunc Go(name string, fn func()) {\n\tgo func() {\n\t\tdefer func() { recover() }()\n\t\tfn()\n\t}()\n}\n';
  assert.deepEqual(census({ 'spawn.go': entrance }, config), []);
  assert.deepEqual(census({ 'other.go': entrance }, config), ['other.go:4 go.go-statement', 'other.go:5 go.recover']);
});

test('a pending rule reports its findings with the item that enables it and is not enforced', () => {
  const config = checker.parseCensusConfig('census.json', JSON.stringify({ pending: { 'go.go-statement': 'F160.4' } }));
  const findings = checker.censusFindings(new Map([['a.go', 'package a\n\nfunc f() {\n\tgo run()\n}\n'], ['b.rs', 'fn f() { x.unwrap_or(1); }\n']]), config);
  assert.deepEqual(findings.map(({ rule, pending }) => `${rule} ${pending}`), ['go.go-statement F160.4', 'rs.unwrap-or null']);
});

test('a census declaration with an unknown key, an unknown rule or a pending value that is no checklist id is an error naming the file', () => {
  const parse = (value) => () => checker.parseCensusConfig('scripts/census.json', JSON.stringify(value));
  assert.throws(parse({ skip: [] }), /^Error: scripts\/census\.json: has the key skip/);
  assert.throws(parse({ pending: { 'go.nothing': 'F1' } }), /scripts\/census\.json: names the rule go\.nothing, which no census rule has/);
  assert.throws(parse({ entrances: { 'go.nothing': [] } }), /names the rule go\.nothing/);
  assert.throws(parse({ pending: { 'go.recover': 'later' } }), /gives the rule go\.recover the pending item "later", which is no checklist id/);
  assert.throws(parse({ entrances: { 'go.recover': 'a.go' } }), /entrances that are not a list of patterns/);
  assert.throws(() => checker.parseCensusConfig('scripts/census.json', '{'), /^Error: scripts\/census\.json: /);
  assert.equal(EVENT_RULES.every((rule) => rule.language && rule.pattern && ['entrance', 'event-or-reason'].includes(rule.requires) && rule.description), true);
});

test('a reason marker is the one form `(default|silent): <reason>`', () => {
  for (const form of ['// 기본값: 명세의 글자 크기는 13이다.', '// Default: the specification fixes the size.', '// DEFAULT: the specification fixes the size.', '// Silent: nobody listens to this.', '// default - the specification fixes the size.', '/* fallback: the specification fixes the size. */', '// default:the specification fixes the size.', ' * silent : nobody listens to this.']) {
    const errors = checker.markerErrors('a.js', `const a = 1;\n${form}\n`);
    assert.equal(errors.length, 1, form);
    assert.match(errors[0], /^a\.js:2: reason marker ".+" is not the form "\(default\|silent\): <reason>"$/, form);
  }
  assert.deepEqual(checker.markerErrors('a.js', '// default: the specification fixes the size.\n// silent: nobody listens to this.\nconst x = 1; // default: fixed by the contract.\n  /** default: the contract fixes it. */\nswitch (x) { default: break; }\n'), []);
});

test('functionRange holds the offset in the named function of Go and Rust, the function-like block of JavaScript and the outermost block of Objective-C', () => {
  const slice = (path, text, marker) => {
    const [start, end] = checker.functionRange(checker.lexSource(path, text), text.indexOf(marker));
    return text.slice(start, end + 1);
  };
  assert.equal(slice('a.go', 'func (r *R) a() {\n\tif x {\n\t\tfunc() { y() }()\n\t}\n}\n', 'y()'), '{\n\tif x {\n\t\tfunc() { y() }()\n\t}\n}');
  assert.equal(slice('a.rs', 'impl A {\n    fn a(&self) {\n        let f = |x| { y(x) };\n    }\n}\n', 'y(x)'), '{\n        let f = |x| { y(x) };\n    }');
  assert.equal(slice('a.js', 'const f = () => {\n  if (a) {\n    y();\n  }\n};\n', 'y()'), '{\n  if (a) {\n    y();\n  }\n}');
  assert.equal(slice('a.m', '- (void)a {\n    [x run:^{ y(); }];\n}\n', 'y()'), '{\n    [x run:^{ y(); }];\n}');
  assert.deepEqual(checker.functionRange(checker.lexSource('a.js', 'y();\n'), 0), [0, 5]);
});

test('soksak-events is a command of the package, and it fails with the file and line of a source that has neither an event nor a reason', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.bin['soksak-events'], './events-check.js');
  assert.ok(manifest.files.includes('events-check.js') && manifest.files.includes('census-rules.json'));
  const command = fileURLToPath(new URL('../events-check.js', import.meta.url));
  const repository = mkdtempSync(join(tmpdir(), 'census-'));
  const run = (...args) => spawnSync(process.execPath, [command, ...args], { cwd: repository, encoding: 'utf8' });
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: repository }).status, 0);
  git('init', '-q');
  mkdirSync(join(repository, 'src'));
  writeFileSync(join(repository, 'src', 'a.rs'), 'fn f() {\n    let v = x.unwrap_or(0);\n}\n');
  writeFileSync(join(repository, 'census.json'), JSON.stringify({ pending: { 'rs.unwrap-or': 'F1.1' } }));
  git('add', 'src/a.rs', 'census.json');
  let result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^src\/a\.rs:2: rs\.unwrap-or has neither an event nor a stated reason$/m);
  result = run('--census', 'census.json');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^pending F1\.1: rs\.unwrap-or is not enforced; 1 findings wait for it$/m);
  assert.match(result.stdout, /^Census passed: 1 sources, 1 rules pending$/m);
  writeFileSync(join(repository, 'src', 'a.rs'), 'fn f() {\n    // Default: a missing count means zero.\n    let v = x.unwrap_or(0);\n}\n');
  result = run('--census', 'census.json');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^src\/a\.rs:2: reason marker "Default: a missing count means zero\." is not the form/m);
  writeFileSync(join(repository, 'src', 'a.rs'), 'fn f() {\n    // default: a missing count means zero.\n    let v = x.unwrap_or(0);\n}\n');
  assert.equal(run().status, 0);
  mkdirSync(join(repository, 'docs'));
  writeFileSync(join(repository, 'docs', 'events.json'), JSON.stringify({ schema: 1, layers: ['host'], events: { 'host.never.emitted': { layer: 'host', class: 'lifecycle', level: 'info', fields: {} } } }));
  result = run('--catalog', 'docs/events.json');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^docs\/events\.json: host\.never\.emitted is declared and no source emits it$/m);
  assert.equal(run('--unknown').status, 1);
  assert.match(run('--unknown').stderr, /usage: soksak-events/);
});

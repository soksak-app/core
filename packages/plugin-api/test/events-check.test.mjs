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

test('the record calls of the native library are emit sites of the declared records, and a record in another function does not accept a return', () => {
  assert.deepEqual(census({
    'a.m': '- (BOOL)f {\n    sp_log_error("where", "text");\n    return NO;\n}\n- (BOOL)g {\n    sp_log_info("where", "text");\n    return NO;\n}\n',
  }), []);
  assert.deepEqual(census({
    'a.m': '- (BOOL)f {\n    sp_log_error("where", "text");\n    return YES;\n}\n- (BOOL)g {\n    return NO;\n}\n',
  }), ['a.m:6 m.error-return']);
  const records = { ...catalog, events: { 'native.record.<level>': { layer: 'host', class: 'lifecycle', level: ['error', 'info'], fields: { where: 'string', text: 'string' } } } };
  assert.deepEqual(checker.emitFindings(records, new Map([['a.m', 'void f(void) {\n    sp_log_error("w", "t");\n    sp_log_info("w", "t");\n}\n']]), CATALOG), []);
});

test('the census exclude removes a vendored file before the catalog check parses it', () => {
  const command = fileURLToPath(new URL('../events-check.js', import.meta.url));
  const repository = mkdtempSync(join(tmpdir(), 'census-'));
  const run = (...args) => spawnSync(process.execPath, [command, ...args], { cwd: repository, encoding: 'utf8' });
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: repository }).status, 0);
  git('init', '-q');
  mkdirSync(join(repository, 'docs'));
  mkdirSync(join(repository, 'ui', 'vendor'), { recursive: true });
  writeFileSync(join(repository, 'docs', 'events.json'), JSON.stringify({ schema: 1, layers: ['plugin'], events: {} }));
  // The vendored file holds a string that does not end, which the lexer of the check rejects.
  writeFileSync(join(repository, 'ui', 'vendor', 'bundle.js'), 'export const a = "never ends;\n');
  writeFileSync(join(repository, 'census.json'), JSON.stringify({ exclude: '^ui/vendor/' }));
  git('add', 'docs/events.json', 'ui/vendor/bundle.js', 'census.json');
  let result = run('--catalog', 'docs/events.json');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^ui\/vendor\/bundle\.js:1: a string that starts here does not end$/m);
  result = run('--census', 'census.json', '--catalog', 'docs/events.json');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Event catalog checks passed: 0 declared events/m);
  assert.deepEqual(checker.catalogReport(repository, 'docs/events.json', 'census.json').findings, []);
});

// A plugin stores its events through `context.runtime.log` (docs/spec/plugins.md#logging): the call names the event without the
// prefix `plugin.<plugin>.`, so the check resolves it against the one plugin id of the catalog.
test('runtime.log entrances of plugin events are resolved by the plugin prefix', () => {
  const plugin = {
    schema: 2,
    layers: ['plugin'],
    events: { 'plugin.fixture.input.key': { layer: 'plugin', class: 'input', level: 'debug', fields: { key: 'string', 'shift?': 'boolean' } } },
  };
  const check = (text) => checker.emitFindings(plugin, new Map([['ui/a.js', text]]), 'events.json');
  assert.deepEqual(check('export function f(runtime, key) {\n  runtime.log.debug("input.key", { key });\n}\n'), []);
  assert.deepEqual(check('export function f(context, key) {\n  context.runtime.log.debug("input.key", () => ({ key, shift: true }));\n}\n'), []);
  assert.deepEqual(check('export function f(runtime, level, key) {\n  runtime.log[level]("input.key", { key });\n}\n'), []);
  assert.deepEqual(check('export function f(runtime, key) {\n  runtime.log.info("input.key", { key, extra: 1 });\n  runtime.log.debug("input.other", {});\n}\n'), [
    'ui/a.js:2: plugin.*.input.key is emitted at the level info and the catalog declares debug',
    'ui/a.js:2: plugin.*.input.key has the field extra, which the catalog does not declare',
    'ui/a.js:3: plugin.*.input.other is emitted and events.json does not declare it',
  ]);
  assert.deepEqual(check('export function f(runtime, key) {\n  runtime.log.debug("input.key", () => ({ key, extra: 1 }));\n}\n'), [
    'ui/a.js:2: plugin.*.input.key has the field extra, which the catalog does not declare',
  ]);
  // The event name that a site builds needs the marker, as at every other site, and the gate query is no site.
  assert.deepEqual(check('export function f(runtime, name) {\n  if (runtime.log.enabled("debug")) runtime.log.debug(name, {});\n}\n'), [
    'ui/a.js:2: the name of this emit is not a literal; write a comment `events: <declared names>` above it, or `events: forwarded` when it passes the name of its caller',
    'events.json: plugin.fixture.input.key is declared and no source emits it',
  ]);
  // A call in a function accepts the rules of the census like any other entrance.
  const rules = checker.censusRules();
  const config = checker.parseCensusConfig('census.json', '{}', rules);
  assert.deepEqual(checker.censusFindings(new Map([['ui/a.js', 'export function f(runtime) {\n  try { g(); } catch (error) { runtime.log.error("input.key", {}); }\n}\n']]), config, rules), []);
});

// A Rust sidecar writes events through methods of its own writer. The declaration file of the repository (`emitters`, by language)
// names each method with the positions of its arguments, so the check finds the sites without naming a repository.
const EMITTERS = {
  emitters: {
    rs: [
      { call: 'emit', level: 0, event: 1, fields: 2 },
      { call: 'emit_for', level: 0, event: 1, fields: 3 },
      { call: 'record_error', fixed: 'error', name: 'sidecar.alpha.record.error', event: 0 },
      { call: 'record_info', fixed: 'info', name: 'sidecar.alpha.record.info', event: 0, only: '^src/' },
    ],
  },
};
const sidecar = {
  schema: 2,
  layers: ['sidecar'],
  sidecar: 'alpha',
  events: {
    'sidecar.alpha.write': { layer: 'sidecar', class: 'io', level: 'debug', fields: { sequence: 'number', hex: 'string' } },
    'sidecar.alpha.start': { layer: 'sidecar', class: 'lifecycle', level: 'info', fields: { pid: 'number' } },
    'sidecar.alpha.record.<level>': { layer: 'sidecar', class: 'lifecycle', level: ['error', 'info'], fields: { where: 'string', text: 'string' } },
  },
};
const RUST = [
  'impl Writer {',
  '    pub fn emit<T: Serialize>(&self, level: Level, event: &str, fields: &T) -> bool {',
  '        self.emit_for(level, event, Subject::NONE, fields)',
  '    }',
  '    pub fn record_error(&self, place: &str, text: impl Display) {',
  '        self.emit(Level::Error, "sidecar.alpha.record.error", &json!({"where": place, "text": text.to_string()}));',
  '    }',
  '}',
  'fn run(log: &Writer) {',
  '    log.emit(Level::Info, "sidecar.alpha.start", &json!({"pid": 1}));',
  '    log.emit_for(',
  '        Level::Debug,',
  '        "sidecar.alpha.write",',
  '        Subject::session("s", &[]),',
  '        &json!({"sequence": 1, "hex": "00"}),',
  '    );',
  '    log.record_info("font", "installed");',
  '}',
  '',
].join('\n');

test('the emitters of a repository declaration make the writer methods of a Rust sidecar emit sites, with their argument positions', () => {
  const config = checker.parseCensusConfig('census.json', JSON.stringify(EMITTERS));
  const sources = new Map([['src/a.rs', RUST]]);
  assert.deepEqual(checker.emitFindings(sidecar, sources, 'events.json', config), [
    'src/a.rs:3: the name of this emit is not a literal; write a comment `events: <declared names>` above it, or `events: forwarded` when it passes the name of its caller',
  ]);
  assert.deepEqual(checker.siteCounts(sources, config.emitters), { rs: { literal: 4, built: 1 } });
  const wrong = new Map([['src/a.rs', RUST.replace('"sidecar.alpha.write"', '"sidecar.alpha.surprise"')]]);
  assert.deepEqual(checker.emitFindings(sidecar, wrong, 'events.json', config).filter((finding) => !finding.includes('not a literal')), [
    'src/a.rs:13: sidecar.alpha.surprise is emitted and events.json does not declare it',
    'events.json: sidecar.alpha.write is declared and no source emits it',
  ]);
  const levels = new Map([['src/a.rs', RUST.replace('Level::Debug', 'Level::Warn').replace('"hex": "00"', '"hex": "00", "extra": 1')]]);
  assert.deepEqual(checker.emitFindings(sidecar, levels, 'events.json', config).filter((finding) => !finding.includes('not a literal')), [
    'src/a.rs:13: sidecar.alpha.write is emitted at the level warn and the catalog declares debug',
    'src/a.rs:13: sidecar.alpha.write has the field extra, which the catalog does not declare',
  ]);
  // An emitter with `only` is a site in the files it names and nowhere else.
  assert.deepEqual(checker.siteCounts(new Map([['lib/a.rs', RUST]]), config.emitters), { rs: { literal: 3, built: 1 } });
});

test('an emitter is an event of its function for the census, and a repository without emitters finds no site of these methods', () => {
  const config = checker.parseCensusConfig('census.json', JSON.stringify(EMITTERS));
  const source = 'fn f(log: &Writer) {\n    let _ = g().ok();\n    log.record_error("g", "failed");\n}\nfn h() {\n    let _ = g().ok();\n}\n';
  assert.deepEqual(checker.censusFindings(new Map([['a.rs', source]]), config).map(({ file, line, rule }) => `${file}:${line} ${rule}`), ['a.rs:6 rs.ok-discard']);
  const bare = checker.parseCensusConfig('census.json', '{}');
  assert.deepEqual(checker.censusFindings(new Map([['a.rs', source]]), bare).map(({ line }) => line), [2, 6]);
  assert.deepEqual(checker.siteCounts(new Map([['src/a.rs', RUST]]), bare.emitters), { rs: { literal: 0, built: 0 } });
});

test('a declaration of emitters outside the form is an error naming the file, the language and the emitter', () => {
  const parse = (emitters) => () => checker.parseCensusConfig('census.json', JSON.stringify({ emitters }));
  assert.throws(parse({ cobol: [] }), /^Error: census\.json: emitters names the language cobol, which is not one of go, rs, m, js/);
  assert.throws(parse({ rs: {} }), /census\.json: emitters\.rs is not a list/);
  assert.throws(parse({ rs: [{ call: 'emit-for', level: 0, event: 1 }] }), /census\.json: emitters\.rs\[0\]: call "emit-for" is not an identifier/);
  assert.throws(parse({ rs: [{ call: 'emit', level: 0, event: 1, shape: 1 }] }), /census\.json: emitters\.rs\[0\]: has the key shape, which is not one of/);
  assert.throws(parse({ rs: [{ call: 'emit', event: 1 }] }), /census\.json: emitters\.rs\[0\]: needs level \(the position of the level argument\) or fixed/);
  assert.throws(parse({ rs: [{ call: 'emit', level: 0, fixed: 'info', event: 1 }] }), /census\.json: emitters\.rs\[0\]: has level and fixed/);
  assert.throws(parse({ rs: [{ call: 'emit', level: 0 }] }), /census\.json: emitters\.rs\[0\]: event must be a non-negative integer/);
  assert.throws(parse({ rs: [{ call: 'emit', level: -1, event: 1 }] }), /census\.json: emitters\.rs\[0\]: level must be a non-negative integer/);
  assert.throws(parse({ rs: [{ call: 'emit', fixed: 'loud', event: 0 }] }), /census\.json: emitters\.rs\[0\]: fixed "loud" is not a level/);
  assert.throws(parse({ rs: [{ call: 'emit', level: 0, event: 1 }, { call: 'emit', level: 0, event: 1 }] }), /census\.json: emitters\.rs\[1\]: call emit is declared twice/);
  assert.throws(parse({ rs: [{ call: 'emit', level: 0, event: 1, only: '(' }] }), /census\.json: emitters\.rs\[0\]: only is not a pattern/);
});

test('soksak-events --catalog finds the emit sites of a Rust sidecar through the emitters of its census declaration', () => {
  const command = fileURLToPath(new URL('../events-check.js', import.meta.url));
  const repository = mkdtempSync(join(tmpdir(), 'census-'));
  const run = (...args) => spawnSync(process.execPath, [command, ...args], { cwd: repository, encoding: 'utf8' });
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: repository }).status, 0);
  git('init', '-q');
  mkdirSync(join(repository, 'src'));
  writeFileSync(join(repository, 'events.json'), JSON.stringify(sidecar));
  writeFileSync(join(repository, 'src', 'a.rs'), RUST.replace('self.emit_for(level, event, Subject::NONE, fields)', '// events: forwarded\n        self.emit_for(level, event, Subject::NONE, fields)'));
  writeFileSync(join(repository, 'census.json'), JSON.stringify(EMITTERS));
  git('add', 'events.json', 'src/a.rs', 'census.json');
  let result = run('--catalog', 'events.json');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /emit sites: rs 0 literal 0 built/);
  result = run('--census', 'census.json', '--catalog', 'events.json');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Event catalog checks passed: 3 declared events, emit sites: rs 4 literal 1 built/m);
});

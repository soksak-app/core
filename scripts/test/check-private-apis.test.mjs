import assert from 'node:assert/strict';
import test from 'node:test';

import { apiUses, declaredApis, inventoryFindings, trackedInventoryFindings, unusedDeclarations, withoutComments } from '../check-private-apis.mjs';

const DOCUMENT = 'docs/operations/private-native-apis.md';
const HEADER = 'native/darwin/src/private/webkit.h';
const HEADERS = new Map([[HEADER, [
  '// Private WebKit declarations.',
  '#import <WebKit/WebKit.h>',
  '@protocol SPThing <NSObject>',
  '- (void)close;',
  '@end',
  '@interface WKWebView (SPPrivate)',
  '// WKWebViewPrivate.h',
  '- (void)_setScale:(double)scale;',
  '@property (nonatomic, setter=_setOcclusion:) BOOL _occlusion;',
  '@property (nonatomic, readonly) id<SPThing> _thing;',
  '+ (void)_collectWithLimit:(int)limit after:(void (^)(void))completion API_AVAILABLE(macos(11.0));',
  '@end',
  'extern void WKDoThing(SPCount value);',
  'static const int kSPField = 51;',
  '@protocol SPDelegate <NSObject>',
  '@optional',
  '- (void)_thingDidEnd:(id)thing;',
  '@end',
  'typedef int SPCount;',
  'typedef void (SPHook)(int value);',
  'extern SPHook *SPCurrentHook;',
].join('\n')]]);

const SCALE = 'native/darwin/src/scale.m';
const OCCLUSION = 'native/darwin/src/occlusion.m';
const THING = 'native/darwin/tests/thing_test.m';
const WINDOW = 'native/darwin/src/window.m';
const DELEGATE = 'native/darwin/src/delegate.m';
const HOOK = 'native/darwin/tests/hook_test.m';
const GO = 'packages/host/go/src/platform/darwin/thing.go';
const RUST = 'packages/host/rust/src/platform/darwin/field.rs';
const SOURCES = new Map([
  [SCALE, 'void sp_scale(WKWebView *view) {\n    [view _setScale:2];\n}\n'],
  [OCCLUSION, '- (void)hide {\n    [self.view _setOcclusion:YES];\n    // WKDoThing(1) is not called here.\n}\n'],
  [THING, 'int main(void) {\n    id<SPThing> thing = view._thing;\n    [thing close];\n    [WKWebView _collectWithLimit:1 after:^{}];\n}\n'],
  [WINDOW, 'static void closeWindow(NSWindow *window) {\n    [window close];\n    printf("// not a comment");\n}\n- (void)close {\n}\n'],
  [DELEGATE, '- (void)_thingDidEnd:(id)thing {\n}\n'],
  [GO, 'package darwin\n\n/*\nstatic void call(void) { WKDoThing(1); }\n*/\nimport "C"\n\nfunc Call() { C.call() }\n'],
  [RUST, 'pub fn field() -> i64 {\n    let label = \'a\';\n    unsafe { sp_field(kSPField) }\n}\n'],
  [HOOK, 'static void hook(int value) {\n}\n\nvoid sp_hook(void) {\n    SPCurrentHook = hook;\n}\n'],
]);

const row = (names, callers) => `| ${names} | ${callers} | Purpose |`;
const link = (path) => `[\`${path.split('/').at(-1)}\`](../../${path})`;
// The first row of the table is on line 7.
const inventory = (rows) => [
  '# Private native API inventory', '', '## Current inventory', '',
  '| API or key | Caller and scope | Purpose |', '| --- | --- | --- |', ...rows, '', '## Necessity review', '',
].join('\n');
const COMPLETE = [
  row('`WKWebView._setScale:`', `${link(SCALE)}, \`sp_scale\``),
  row('`WKWebView._setOcclusion:`', `${link(OCCLUSION)}, \`hide\``),
  row('`WKWebView._thing`, `SPThing`, `SPThing.close`, `+[WKWebView _collectWithLimit:after:]`', link(THING)),
  row('`WKDoThing`, `SPCount`', `The Wails host; ${link(GO)}, \`Call\``),
  row('`kSPField`', `${link(RUST)}, \`field\``),
  row('Public `NSWindow.close`', `${link(WINDOW)}, \`closeWindow\``),
  row('`SPDelegate`, `SPDelegate._thingDidEnd:`', `${link(DELEGATE)}, \`_thingDidEnd:\``),
  row('`SPCurrentHook`, `SPHook`', `${link(HOOK)}, \`sp_hook\``),
];
const findings = (rows) => inventoryFindings({ apis: declaredApis(HEADERS), sources: SOURCES, document: DOCUMENT, markdown: inventory(rows) });

test('comments are removed and strings, character literals and the cgo preamble of a Go file are kept', () => {
  assert.equal(withoutComments('a.m', 'a(); // b\n/* c\n d */ e("// f");'), `a();${' '.repeat(5)}\n${' '.repeat(4)}\n${' '.repeat(6)}e("// f");`);
  assert.equal(withoutComments('a.rs', "let c = '/'; /* a /* b */ c */ d('a); // e"), `let c = '/'; ${' '.repeat(17)} d('a); ${' '.repeat(4)}`);
  assert.equal(withoutComments('a.go', 's := `//` // a\n/*\nf(); // g\n*/\nimport "C"'), 's := `//`     \n  \nf();     \n  \nimport "C"');
  assert.throws(() => withoutComments('a.m', 'a /* b'), /a\.m: a block comment is not closed/);
});

test('the declarations of a header are its functions, constants, types and the members of its categories, classes and protocols', () => {
  assert.deepEqual(declaredApis(HEADERS).map(({ names, line }) => [names, line]), [
    [['SPThing'], 3],
    [['SPThing.close'], 4],
    [['WKWebView._setScale:'], 8],
    [['WKWebView._occlusion', 'WKWebView._setOcclusion:'], 9],
    [['WKWebView._thing'], 10],
    [['+[WKWebView _collectWithLimit:after:]'], 11],
    [['WKDoThing'], 13],
    [['kSPField'], 14],
    [['SPDelegate'], 15],
    [['SPDelegate._thingDidEnd:'], 17],
    [['SPCount'], 19],
    [['SPHook'], 20],
    [['SPCurrentHook'], 21],
  ]);
  assert.throws(() => declaredApis(new Map([[HEADER, '@class SPLater;']])),
    /native\/darwin\/src\/private\/webkit\.h:1: the check reads no declaration of this form: @class SPLater/);
});

test('a source uses a member of a declared type only when it uses the type or defines an optional protocol member, and an identifier only outside comments', () => {
  const uses = apiUses(declaredApis(HEADERS), SOURCES);
  const named = (path) => [...(uses.get(path) ?? [])].sort();
  assert.deepEqual(named(SCALE), ['WKWebView._setScale:']);
  assert.deepEqual(named(OCCLUSION), ['WKWebView._occlusion']);
  assert.deepEqual(named(THING), ['+[WKWebView _collectWithLimit:after:]', 'SPThing', 'SPThing.close', 'WKWebView._thing']);
  // `[window close]` and `- (void)close` in a source that does not use SPThing neither send nor implement SPThing.close.
  assert.deepEqual(named(WINDOW), []);
  // The framework calls an optional protocol member on an object of the application, which defines it without naming the protocol.
  assert.deepEqual(named(DELEGATE), ['SPDelegate', 'SPDelegate._thingDidEnd:']);
  // A source that calls WKDoThing uses the type of its parameter.
  assert.deepEqual(named(GO), ['SPCount', 'WKDoThing']);
  assert.deepEqual(named(RUST), ['kSPField']);
  // A source that sets SPCurrentHook uses the function type of its declaration.
  assert.deepEqual(named(HOOK), ['SPCurrentHook', 'SPHook']);
});

test('an inventory whose rows name every declared API and link exactly the sources that use it has no finding', () => {
  assert.deepEqual(findings(COMPLETE), []);
});

test('a declared API that no row names is a finding at its declaration, with the sources that use it', () => {
  assert.deepEqual(findings(COMPLETE.filter((text) => !text.includes('WKDoThing'))), [
    `${HEADER}:13: \`WKDoThing\` has no row in ${DOCUMENT} (used by ${GO})`,
    `${HEADER}:19: \`SPCount\` has no row in ${DOCUMENT} (used by ${GO})`,
  ]);
});

test('a source that uses an API and that no row naming the API links is a finding', () => {
  const rows = COMPLETE.map((text) => (text.includes('WKDoThing') ? row('`WKDoThing`, `SPCount`', 'The Wails host') : text));
  assert.deepEqual(findings(rows), [
    `${DOCUMENT}:10: ${GO} uses \`WKDoThing\`, and no row that names it links the file`,
    `${DOCUMENT}:10: ${GO} uses \`SPCount\`, and no row that names it links the file`,
  ]);
});

test('a linked source that uses no API of its row is a finding', () => {
  const rows = COMPLETE.map((text) => (text.includes('`kSPField`') ? row('`kSPField`', `${link(RUST)}, \`field\`; ${link(SCALE)}`) : text));
  assert.deepEqual(findings(rows), [
    `${DOCUMENT}:11: the row links ${SCALE}, which uses no API that the row names`,
  ]);
});

test('a function, method or class that a row names in its caller column and that no linked file defines is a finding', () => {
  const rows = [row('`WKWebView._setScale:`', `${link(SCALE)}, \`sp_scale\` and \`sp_resize\`; \`SPScaler\` sets \`host.window\` (\`_setScale:\`)`), ...COMPLETE.slice(1)];
  assert.deepEqual(findings(rows), [
    `${DOCUMENT}:7: the row names \`sp_resize\`, which no file that the row links defines (${SCALE})`,
    `${DOCUMENT}:7: the row names \`SPScaler\`, which no file that the row links defines (${SCALE})`,
    `${DOCUMENT}:7: the row names \`_setScale:\`, which no file that the row links defines (${SCALE})`,
  ]);
});

test('a declaration that no source uses is a finding at its declaration', () => {
  const headers = new Map([[HEADER, `${HEADERS.get(HEADER)}\nextern void WKUnused(void);`]]);
  const apis = declaredApis(headers);
  assert.deepEqual(unusedDeclarations(apis, apiUses(apis, SOURCES)), [`${HEADER}:22: \`WKUnused\` is declared, and no source uses it`]);
  assert.deepEqual(unusedDeclarations(declaredApis(HEADERS), apiUses(declaredApis(HEADERS), SOURCES)), []);
});

test('the private API inventory and its translation agree with the private declarations and the sources', () => {
  assert.deepEqual(trackedInventoryFindings(), []);
});

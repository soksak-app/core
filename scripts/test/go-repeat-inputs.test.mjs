import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGoNativeInputs } from '../go-repeat-inputs.mjs';

const PREFIX = 'github.com/soksak-app/core/packages/host/';
const PRODUCTION = PREFIX + 'mygo/src/platform/darwin/bindings';
const STANDALONE = PREFIX + 'go/tests/platform/darwin/standalone/';
const FRAME = PREFIX + 'mygo/tests/platform/darwin/bindings';
const LIBRARY = PREFIX + 'go/tests/platform/darwin/testlibrary';
const CALLBACK = PREFIX + 'mygo/tests/platform/darwin/nativecallback';
const WORKER = PREFIX + 'mygo/tests/platform/darwin/nativeworker';

function fixture(t, graph, cgo = '0') {
  const cwd = mkdtempSync(join(tmpdir(), 'go-native-inputs-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const artifacts = {};
  for (const key of ['productionStatic', 'productionDynamic', 'testStatic', 'testDynamic', 'callback', 'worker']) {
    artifacts[key] = join(cwd, key + '.native');
    writeFileSync(artifacts[key], key);
  }
  const variables = {
    'soksak-darwin:static_library': artifacts.productionStatic,
    'soksak-darwin:dynamic_library': artifacts.productionDynamic,
    'soksak-host-test:static_library': artifacts.testStatic,
    'soksak-host-test:dynamic_library': artifacts.testDynamic,
    'soksak-host-test:callback_abi_library': artifacts.callback,
    'soksak-host-test:callback_worker_library': artifacts.worker,
  };
  const calls = [];
  const env = { CGO_ENABLED: cgo, USER_SECRET: 'must not be printed', CGO_CFLAGS: '-DDECLARED=1' };
  const run = (command, args, options) => {
    calls.push({ command, args, env: options.env, maxBuffer: options.maxBuffer });
    assert.equal(options.cwd, cwd);
    assert.equal(options.env.CGO_ENABLED, cgo);
    if (command === 'go' && args[0] === 'env') return cgo + '\n';
    if (command === 'go' && args[0] === 'list') {
      assert.ok(args.includes('-deps') && args.includes('-test') && args.includes('-json'));
      return graph.map((item) => JSON.stringify(item)).join('\n');
    }
    if (command === 'pkg-config') {
      const variable = args.find((arg) => arg.startsWith('--variable='))?.slice('--variable='.length);
      const pkg = args.find((arg) => arg === 'soksak-darwin' || arg === 'soksak-host-test');
      const value = variables[pkg + ':' + variable];
      assert.ok(value, `unexpected pkg-config query: ${args.join(' ')}`);
      return value + '\n';
    }
    throw new Error(`unexpected native discovery command: ${command} ${args.join(' ')}`);
  };
  return { cwd, env, run, calls, artifacts };
}

// A graph whose test executable links each of the packages, as `go list -deps -test` lists it.
function linked(...nodes) {
  return [...nodes, { ImportPath: 'fixture/selected.test', Deps: nodes.map((node) => node.ImportPath) }];
}

function resolve(input, extra = {}) {
  return resolveGoNativeInputs({ patterns: ['./selected/...'], tags: 'diagnostics', ...input, ...extra });
}

test('native discovery uses selected Go import IDs and leaves unrelated graphs free of pkg-config work', (t) => {
  const input = fixture(t, [{ ImportPath: 'example.test/plain', Dir: '/pretend/packages/host/mygo/src/platform/darwin/bindings' }]);
  const result = resolve(input);
  assert.equal(result.cgoEnabled, false);
  assert.equal(result.env.USER_SECRET, input.env.USER_SECRET);
  assert.equal(result.env.CGO_CFLAGS, '-DDECLARED=1');
  assert.ok(input.calls.every((call) => call.command === 'go'));
  const listed = input.calls.find((call) => call.args[0] === 'list');
  assert.ok(listed.args.includes('diagnostics') && listed.args.includes('./selected/...'));
});

test('cgo-free production and test bindings resolve declared dynamic artifacts before build', (t) => {
  const input = fixture(t, linked({ ImportPath: PRODUCTION }, { ImportPath: FRAME }));
  const result = resolve(input);
  assert.equal(result.env.SOKSAK_NATIVE_LIBRARY, input.artifacts.productionDynamic);
  assert.equal(result.env.SOKSAK_NATIVE_TEST_LIBRARY, input.artifacts.testDynamic);
  assert.equal(result.env.CGO_CFLAGS, '-DDECLARED=1');
  const graph = input.calls.findIndex((call) => call.args[0] === 'list');
  assert.ok(input.calls.filter((call) => call.command === 'pkg-config').every((call) => input.calls.indexOf(call) > graph));
});

test('standalone dynamic bindings and the shared loader select their exact declared artifacts', (t) => {
  const input = fixture(t, linked({ ImportPath: STANDALONE + 'dynamic' }, { ImportPath: STANDALONE + 'testdynamic' }, { ImportPath: LIBRARY }));
  const result = resolve(input);
  assert.equal(result.env.SOKSAK_NATIVE_LIBRARY, input.artifacts.productionDynamic);
  assert.equal(result.env.SOKSAK_NATIVE_TEST_LIBRARY, input.artifacts.testDynamic);
  assert.equal(input.calls.filter((call) => call.command === 'pkg-config').length, 2);
});

test('a selected binding that no test executable links needs no artifact', (t) => {
  const input = fixture(t, [
    { ImportPath: STANDALONE + 'dynamic' }, { ImportPath: PRODUCTION }, { ImportPath: FRAME },
    { ImportPath: 'fixture/other.test', Deps: ['fixture/other'] }, { ImportPath: 'fixture/other' },
  ], '1');
  const result = resolve(input);
  assert.equal(result.env.SOKSAK_NATIVE_LIBRARY, undefined);
  assert.equal(result.env.SOKSAK_NATIVE_TEST_LIBRARY, undefined);
  assert.ok(input.calls.every((call) => call.command !== 'pkg-config'));
});

test('explicit native artifact presence rejects invalid values without pkg-config fallback', (t) => {
  for (const value of ['', 'relative.dylib', '/definitely/missing/soksak-native.dylib']) {
    const input = fixture(t, linked({ ImportPath: PRODUCTION }));
    assert.throws(() => resolve(input, { env: { ...input.env, SOKSAK_NATIVE_LIBRARY: value } }), /SOKSAK_NATIVE_LIBRARY/);
    assert.ok(input.calls.every((call) => call.command !== 'pkg-config'));
  }
  const input = fixture(t, linked({ ImportPath: FRAME }));
  assert.throws(() => resolve(input, { env: { ...input.env, SOKSAK_NATIVE_TEST_LIBRARY: input.cwd } }), /SOKSAK_NATIVE_TEST_LIBRARY/);
  assert.ok(input.calls.every((call) => call.command !== 'pkg-config'));
});

test('selected cgo graph hashes both pkg-config static artifacts and preserves caller flags', (t) => {
  const input = fixture(t, [{ ImportPath: 'fixture/cgo', CgoPkgConfig: ['soksak-darwin', 'soksak-host-test'] }], '1');
  const result = resolve(input);
  assert.equal(result.cgoEnabled, true);
  for (const [key, contents] of [['SOKSAK_DARWIN_LIBRARY', 'productionStatic'], ['SOKSAK_HOST_TEST_LIBRARY', 'testStatic']]) {
    const digest = createHash('sha256').update(contents).digest('hex').slice(0, 16);
    assert.ok(result.env.CGO_CFLAGS.includes(`-D${key}=${digest}`), result.env.CGO_CFLAGS);
  }
  assert.ok(result.env.CGO_CFLAGS.startsWith('-DDECLARED=1 '));
  assert.equal(result.env.SOKSAK_NATIVE_LIBRARY, undefined);
});

test('callback fixture artifacts belong only to exact normalized callback test import IDs', (t) => {
  const input = fixture(t, linked(
    { ImportPath: `${CALLBACK}_test [${CALLBACK}.test]`, ForTest: CALLBACK },
    { ImportPath: `${WORKER} [${WORKER}.test]`, ForTest: WORKER },
  ));
  const result = resolve(input);
  assert.equal(result.env.SOKSAK_NATIVE_CALLBACK_ABI_LIBRARY, input.artifacts.callback);
  assert.equal(result.env.SOKSAK_NATIVE_CALLBACK_WORKER_LIBRARY, input.artifacts.worker);
  const unrelated = fixture(t, linked({ ImportPath: PREFIX + 'mygo/src/platform/darwin/nativecallback' }, { ImportPath: CALLBACK + '/support' }));
  resolve(unrelated);
  assert.ok(unrelated.calls.every((call) => call.command !== 'pkg-config'));
});

test('artifact discovery tolerates incomplete test metadata so the mandatory package build reports the failure', (t) => {
  const input = fixture(t, [{
    ImportPath: 'fixture/bad [fixture/bad.test]', ForTest: 'fixture/bad',
    Error: { Err: 'fixture_test.go:3: expected declaration' },
    DepsErrors: [{ ImportStack: ['fixture/bad'], Err: 'fixture dependency is unavailable' }],
  }]);
  const result = resolve(input);
  assert.equal(result.cgoEnabled, false);
  const listed = input.calls.find((call) => call.args[0] === 'list');
  assert.ok(listed.args.includes('-e'), 'graph loading rejected the package before its named test build could fail');
  assert.ok(Number.isInteger(listed.maxBuffer) && listed.maxBuffer >= 16 * 1024 * 1024 && listed.maxBuffer <= 128 * 1024 * 1024,
    'real dependency metadata needs a bounded buffer above execFileSync default');
  assert.ok(input.calls.every((call) => call.command === 'go'));
});

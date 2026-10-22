// Verifies that `make go-repeat` names each test of a Go package when it starts, reports its result and elapsed time, kills a test at
// its own limit, passes the build tags, and judges a package pattern by its test packages. The Go toolchain is replaced by a fake
// `go` on PATH; `make` gets its HOME in the same folder. The fake `go test -c -o <file>` writes a test binary that lists two tests
// (`-test.list`) and runs the test named by `-test.run`. FAKE_GO_MODE selects the packages that `go list` reports: `run` is one
// package with a test file, `support` is a package without test files beside a package with one, and `nofiles` is one package
// without test files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');

// The test named TestBeta hangs for 8 seconds, so only a kill at its limit ends it sooner.
function fakeGo(t) {
  const directory = mkdtempSync(join(tmpdir(), 'soksak-go-repeat-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const go = join(directory, 'go');
  writeFileSync(go, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(join(directory, 'args'))}
case "$*" in
  "list -deps"*) exit 0 ;;
  "list "*ImportPath*)
    case "$FAKE_GO_MODE" in
      nofiles) printf 'fixture/src\\t%s\\t0\\t0\\n' ${JSON.stringify(directory)}; exit 0 ;;
      support) printf 'fixture/tests/support\\t%s\\t0\\t0\\nfixture/tests\\t%s\\t1\\t0\\n' ${JSON.stringify(directory)} ${JSON.stringify(directory)}; exit 0 ;;
      *) printf 'fixture/src\\t%s\\t1\\t0\\n' ${JSON.stringify(directory)}; exit 0 ;;
    esac ;;
  "test -c"*) out=""; while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done
    cat > "$out" <<'BINARY'
#!/bin/sh
case "$1" in -test.list*) printf 'TestAlpha\\nTestBeta\\nBenchmarkGamma\\n'; exit 0 ;; esac
name=$(printf '%s' "$2" | tr -d '^$')
case "$name" in TestBeta) sleep 8 ;; esac
printf '=== RUN   %s\\n--- PASS: %s (0.00s)\\nPASS\\n' "$name" "$name"
BINARY
    chmod +x "$out"; exit 0 ;;
esac
exit 1
`);
  chmodSync(go, 0o755);
  return directory;
}

function makeGo(t, mode, target) {
  const directory = fakeGo(t);
  const result = spawnSync('make', target, {
    cwd: root, env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}`, FAKE_GO_MODE: mode },
    encoding: 'utf8', timeout: 60000,
  });
  return { ...result, directory };
}

test('make go-repeat names each test when it starts, reports its result and elapsed time, and kills a test at its limit', (t) => {
  const { stdout, stderr, status } = makeGo(t, 'run', ['go-repeat', 'PACKAGE=./fixture', 'COUNT=1', 'TEST_TIMEOUT=2']);
  assert.match(stdout, /^RUN  TestAlpha \(1 running, limit 2\.000s\)$/m, stdout + stderr);
  assert.match(stdout, /^PASS TestAlpha \d+\.\d{3}s$/m, stdout + stderr);
  assert.match(stdout, /^RUN  TestBeta \(1 running, limit 2\.000s\)$/m, stdout + stderr);
  assert.match(stdout, /^TIME TestBeta \d+\.\d{3}s exceeded 2\.000s and was killed(?:; left running: .*)?$/m, stdout + stderr);
  const killed = /^TIME TestBeta (\d+)\.\d{3}s/m.exec(stdout);
  assert.ok(killed && Number(killed[1]) < 6, `TestBeta ran to its own sleep instead of its limit: ${stdout}`);
  assert.doesNotMatch(stdout, /BenchmarkGamma/, 'a benchmark ran as a test');
  assert.notEqual(status, 0, stdout + stderr);
  assert.match(stdout, /^FAIL: \.\/fixture run 1 of 1; load /m, stdout + stderr);
});

test('make go-repeat passes the build tags to the list and the test build and selects the named tests', (t) => {
  const directory = fakeGo(t);
  const result = spawnSync('make', ['go-repeat', 'PACKAGE=./fixture', 'COUNT=1', 'TAGS=diagnostics', 'TEST=TestAlpha'], {
    cwd: root, env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}`, FAKE_GO_MODE: 'run' }, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS TestAlpha \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /TestBeta/, 'a test outside TEST ran');
  const calls = readFileSync(join(directory, 'args'), 'utf8').trim().split('\n');
  assert.ok(calls.some((call) => /^list -tags diagnostics /.test(call)), JSON.stringify(calls));
  assert.ok(calls.some((call) => /^test -c .*-tags diagnostics/.test(call)), JSON.stringify(calls));
});

test('make go-repeat fails a package whose test files are not built', (t) => {
  const { stdout, stderr, status } = makeGo(t, 'nofiles', ['go-repeat', 'PACKAGE=./fixture/src', 'COUNT=1', 'TEST=TestAlpha']);
  assert.notEqual(status, 0, stdout + stderr);
  assert.match(stderr, /has no test files built with tags ''/, stdout + stderr);
});

test('make go-repeat passes a pattern whose tested package passed while a support package has no test files', (t) => {
  const { stdout, stderr, status } = makeGo(t, 'support', ['go-repeat', 'PACKAGE=./fixture/tests/...', 'COUNT=1', 'TEST=TestAlpha']);
  assert.equal(status, 0, stdout + stderr);
  assert.match(stdout, /^PASS TestAlpha \d+\.\d{3}s$/m, stdout + stderr);
  assert.match(stdout, /1 of 1 runs pass/, stdout + stderr);
});

test('make go-repeat fails a run in which no test matched', (t) => {
  const { stdout, stderr, status } = makeGo(t, 'run', ['go-repeat', 'PACKAGE=./fixture', 'COUNT=1', 'TEST=TestMissing']);
  assert.notEqual(status, 0, stdout + stderr);
  assert.match(stderr, /no test matching TestMissing/, stdout + stderr);
});

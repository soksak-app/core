// Verifies that `make rust-repeat` names each test of a package when it starts, reports its result and elapsed time, and kills a
// test at its own limit. The Rust toolchain is replaced by a fake `cargo` on PATH; `make` gets its HOME in the same folder so that
// the cargo of `$(HOME)/.cargo/bin` does not shadow the fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cargoTargetArgs, runRustTests } from '../rust-tests.mjs';

const root = resolve(import.meta.dirname, '../..');

// The fake cargo builds nothing and reports one test executable of the package `fixture` in the JSON form of `--no-run`, and its
// manifest in `cargo metadata`. The executable lists two tests (`--list`) and runs the test named by `--exact`. The test named
// beta hangs for 8 seconds, so only a kill at its limit ends it sooner. The library of the package has one documentation test,
// listed by `cargo test --doc -- --list` and run by name with `cargo test --doc -- <name>`.
function fakeCargo(t) {
  const directory = mkdtempSync(join(tmpdir(), 'soksak-rust-repeat-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const executable = join(directory, 'fixture-test');
  writeFileSync(executable, `#!/bin/sh
case "$1" in
  --list) printf 'fixture::alpha: test\\nfixture::beta: test\\n\\n2 tests, 0 benchmarks\\n'; exit 0 ;;
esac
case "$2" in *beta*) sleep 8 ;; esac
printf 'running 1 test\\ntest %s ... ok\\n\\ntest result: ok. 1 passed; 0 failed\\n' "$2"
`);
  chmodSync(executable, 0o755);
  const cargo = join(directory, 'cargo');
  writeFileSync(cargo, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(join(directory, 'args'))}
case "$*" in
  *--doc*--list*) printf 'src/lib.rs - doc_example (line 3): test\\n'; exit 0 ;;
  *--doc*) printf 'running 1 test\\ntest result: ok. 1 passed; 0 failed\\n'; exit 0 ;;
  *message-format=json*) printf '{"reason":"compiler-artifact","profile":{"test":true},"target":{"name":"fixture"},"executable":"${executable}"}\\n'; exit 0 ;;
  metadata*) printf '{"packages":[{"name":"fixture","manifest_path":"${join(directory, 'Cargo.toml')}","targets":[{"kind":["lib"],"doctest":true}]}]}\\n'; exit 0 ;;
  *--no-run*) exit 0 ;;
esac
exit 1
`);
  chmodSync(cargo, 0o755);
  return directory;
}

function targetCargo(t) {
  const directory = mkdtempSync(join(tmpdir(), 'soksak-rust-target-repeat-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const targetLog = join(directory, 'targets');
  const binary = (name, testName) => {
    const executable = join(directory, `${name}-test`);
    writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--list" ]; then
  printf 'list:${name}\\n' >> ${JSON.stringify(targetLog)}
  printf '${testName}: test\\n\\n1 tests, 0 benchmarks\\n'
  exit 0
fi
printf 'run:${name}\\n' >> ${JSON.stringify(targetLog)}
printf 'running 1 test\\ntest %s ... ok\\n\\ntest result: ok. 1 passed; 0 failed\\n' "$2"
`);
    chmodSync(executable, 0o755);
    return executable;
  };
  const library = binary('library', 'fixture::library_case');
  const integration = binary('integration', 'fixture::integration_case');
  const cargo = join(directory, 'cargo');
  writeFileSync(cargo, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(join(directory, 'args'))}
if [ -n "$SOKSAK_TEST_DEPLOYMENT_LOG" ]; then
  printf '%s\\n' "\${MACOSX_DEPLOYMENT_TARGET-unset}" >> "$SOKSAK_TEST_DEPLOYMENT_LOG" || exit 1
fi
case "$*" in
  *--doc*--list*) printf 'list:doctests\\n' >> ${JSON.stringify(targetLog)}; printf 'src/lib.rs - doc_example (line 3): test\\n'; exit 0 ;;
  *--doc*) printf 'running 1 test\\ntest result: ok. 1 passed; 0 failed\\n'; exit 0 ;;
  *message-format=json*)
    case "$*" in
      *--lib*) printf '{"reason":"compiler-artifact","profile":{"test":true},"target":{"name":"fixture","kind":["lib"]},"executable":"${library}"}\\n' ;;
      *--test\\ integration*) printf '{"reason":"compiler-artifact","profile":{"test":true},"target":{"name":"integration","kind":["test"]},"executable":"${integration}"}\\n' ;;
      *)
        printf '{"reason":"compiler-artifact","profile":{"test":true},"target":{"name":"fixture","kind":["lib"]},"executable":"${library}"}\\n'
        printf '{"reason":"compiler-artifact","profile":{"test":true},"target":{"name":"integration","kind":["test"]},"executable":"${integration}"}\\n' ;;
    esac
    exit 0 ;;
  metadata*) printf '{"packages":[{"name":"fixture","manifest_path":"${join(directory, 'Cargo.toml')}","targets":[{"kind":["lib"],"doctest":true},{"kind":["test"],"name":"integration"}]}]}\\n'; exit 0 ;;
  *--no-run*) exit 0 ;;
esac
exit 1
`);
  chmodSync(cargo, 0o755);
  return { directory, targetLog };
}

function selectedTargetTest(t, selection, argument, cargoArgs, expected) {
  const { directory, targetLog } = targetCargo(t);
  const result = spawnSync('make', [
    'rust-repeat', 'PACKAGE=fixture', 'COUNT=1', `TEST=${argument}`, `TEST_TARGET=${selection}`,
  ], {
    cwd: root, env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}` },
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const cargoCalls = readFileSync(join(directory, 'args'), 'utf8').trim().split('\n')
    .filter((call) => call.startsWith('test '));
  assert.equal(cargoCalls.length, 1, JSON.stringify(cargoCalls));
  assert.match(cargoCalls[0], /--no-run/, cargoCalls[0]);
  assert.deepEqual(readFileSync(targetLog, 'utf8').trim().split('\n'), [`list:${expected}`, `run:${expected}`]);
  for (const call of cargoCalls) assert.match(call, cargoArgs, call);
  assert.doesNotMatch(readFileSync(join(directory, 'args'), 'utf8'), /--doc/);
}

test('make rust-repeat selects only the lib Cargo target before discovery', (t) => {
  selectedTargetTest(t, 'lib', 'fixture::library_case', /--lib/, 'library');
});

test('make rust-repeat selects only the test:integration Cargo target before discovery', (t) => {
  selectedTargetTest(t, 'test:integration', 'fixture::integration_case', /--test integration/, 'integration');
});

test('make rust-repeat keeps package-wide target and doctest discovery by default', (t) => {
  const { directory, targetLog } = targetCargo(t);
  const result = spawnSync('make', ['rust-repeat', 'PACKAGE=fixture', 'COUNT=1'], {
    cwd: root, env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}` },
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readFileSync(targetLog, 'utf8').trim().split('\n'), [
    'list:library', 'list:integration', 'list:doctests', 'run:library', 'run:integration',
  ]);
  const calls = readFileSync(join(directory, 'args'), 'utf8');
  assert.match(calls, /--doc -- --list/);
  assert.match(calls, /--doc -- src\/lib\.rs - doc_example \(line 3\)/);
});

test('make rust-repeat rejects an invalid Cargo target before invoking Cargo', (t) => {
  const { directory } = targetCargo(t);
  const result = spawnSync('make', [
    'rust-repeat', 'PACKAGE=fixture', 'COUNT=1', 'TEST_TARGET=test:bad/name',
  ], {
    cwd: root, env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}` },
    encoding: 'utf8', timeout: 60000,
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /--test-target must be lib or test:<Cargo target name>/, result.stdout + result.stderr);
  assert.equal(existsSync(join(directory, 'args')), false, 'Cargo ran before the target selector was rejected');
});

test('make rust-repeat rejects shell syntax in a Cargo target without executing it', (t) => {
  const { directory } = targetCargo(t);
  const marker = join(directory, 'injected-command-ran');
  const result = spawnSync('make', [
    'rust-repeat', 'PACKAGE=fixture', 'COUNT=1', `TEST_TARGET=test:bad'; touch ${marker}; #`,
  ], {
    cwd: root, env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}` },
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(existsSync(marker), false, 'shell syntax in the selector ran as a command');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(directory, 'args')), false, 'Cargo ran before the selector was rejected');
});

test('runRustTests rejects an explicitly empty Cargo target before invoking Cargo', async (t) => {
  const { directory } = targetCargo(t);
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  process.env.PATH = `${directory}:${previousPath}`;
  process.env.HOME = directory;
  try {
    await assert.rejects(runRustTests({
      manifest: 'Cargo.toml', package: 'fixture', testTarget: '', count: 1, timeoutMs: 1000, write() {},
    }), /--test-target must be lib or test:<Cargo target name>/);
    assert.equal(existsSync(join(directory, 'args')), false, 'Cargo ran before the empty selector was rejected');
  } finally {
    process.env.PATH = previousPath;
    process.env.HOME = previousHome;
  }
});

test('cargoTargetArgs rejects non-string selectors instead of coercing them', () => {
  assert.throws(() => cargoTargetArgs(['test:integration']), /--test-target must be a string/);
  assert.throws(() => cargoTargetArgs({ toString: () => 'test:integration' }), /--test-target must be a string/);
});

test('make rust-repeat names each test when it starts, reports its result and elapsed time, and kills a test at its limit', (t) => {
  const directory = fakeCargo(t);
  const result = spawnSync('make', ['rust-repeat', 'PACKAGE=fixture', 'COUNT=1', 'TEST_TIMEOUT=2'], {
    cwd: root, env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}` }, encoding: 'utf8', timeout: 60000,
  });
  assert.match(result.stdout, /^RUN  fixture::alpha \(1 running, limit 2\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS fixture::alpha \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^RUN  fixture::beta \(1 running, limit 2\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^TIME fixture::beta \d+\.\d{3}s exceeded 2\.000s and was killed(?:; left running: .*)?$/m, result.stdout + result.stderr);
  const killed = /^TIME fixture::beta (\d+)\.\d{3}s/m.exec(result.stdout);
  assert.ok(killed && Number(killed[1]) < 6, `beta ran to its own sleep instead of its limit: ${result.stdout}`);
  // make exits with status 2 when a recipe fails; the run fails with the FAIL line of the runner.
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAIL: fixture run 1 of 1; load /m, result.stdout + result.stderr);
});

test('make rust-repeat passes its features to every cargo test call', (t) => {
  const directory = fakeCargo(t);
  const result = spawnSync('make', ['rust-repeat', 'PACKAGE=fixture', 'COUNT=1', 'FEATURES=diagnostics', 'TEST=fixture::alpha'], {
    cwd: root, env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}` }, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = readFileSync(join(directory, 'args'), 'utf8').trim().split('\n').filter((call) => call.startsWith('test '));
  assert.equal(calls.length, 1, JSON.stringify(calls));
  for (const call of calls) assert.match(call, /--features diagnostics/, call);
});

test('make rust-repeat runs each documentation test of the library with its own name, result and elapsed time', (t) => {
  const directory = fakeCargo(t);
  // The make target passes the name quoted: a doc-test name holds spaces and parentheses, which the recipe shell would split.
  const result = spawnSync('make', ['rust-repeat', 'PACKAGE=fixture', 'COUNT=1', 'TEST=src/lib.rs - doc_example (line 3)', 'TEST_TIMEOUT=2'], {
    cwd: root, env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}` }, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^RUN  src\/lib\.rs - doc_example \(line 3\) \(1 running, limit 2\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS src\/lib\.rs - doc_example \(line 3\) \d+\.\d{3}s$/m, result.stdout + result.stderr);
  const calls = readFileSync(join(directory, 'args'), 'utf8').trim().split('\n');
  assert.ok(calls.some((call) => /--doc -- src\/lib\.rs - doc_example \(line 3\)$/.test(call)), JSON.stringify(calls));
});

for (const target of ['rust-repeat', 'rust-tests-alone']) {
  test(`make ${target} applies the declared deployment environment to every Cargo call`, { timeout: 60000 }, (t) => {
    const { directory } = targetCargo(t);
    const deploymentLog = join(directory, 'deployment-targets');
    const args = [target, 'PACKAGE=fixture', 'MACOS_MINIMUM=14.4',
      `PATH=${directory}:${process.env.PATH}`];
    if (target === 'rust-repeat') args.push('COUNT=1', 'TEST=fixture::library_case', 'TEST_TARGET=lib');
    const result = spawnSync('make', args, {
      cwd: root,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MACOSX_DEPLOYMENT_TARGET: '10.9', SOKSAK_TEST_DEPLOYMENT_LOG: deploymentLog },
      encoding: 'utf8', timeout: 60000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const targets = readFileSync(deploymentLog, 'utf8').trim().split('\n');
    assert.ok(targets.length >= 2, `Cargo build and discovery were not observed: ${JSON.stringify(targets)}`);
    assert.deepEqual([...new Set(targets)], ['14.4'], 'Cargo inherited a deployment target different from the declared build');
  });
}

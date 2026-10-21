// Verifies that `make rust-repeat` names each test of a package when it starts, reports its result and elapsed time, and kills a
// test at its own limit. The Rust toolchain is replaced by a fake `cargo` on PATH; `make` gets its HOME in the same folder so that
// the cargo of `$(HOME)/.cargo/bin` does not shadow the fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');

// The fake cargo builds nothing and reports one test executable of the package `fixture` in the JSON form of `--no-run`, and its
// manifest in `cargo metadata`. The executable lists two tests (`--list`) and runs the test named by `--exact`. The test named
// beta hangs for 8 seconds, so only a kill at its limit ends it sooner.
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
case "$*" in
  *message-format=json*) printf '{"reason":"compiler-artifact","profile":{"test":true},"target":{"name":"fixture"},"executable":"${executable}"}\\n'; exit 0 ;;
  metadata*) printf '{"packages":[{"name":"fixture","manifest_path":"${join(directory, 'Cargo.toml')}"}]}\\n'; exit 0 ;;
  *--no-run*) exit 0 ;;
esac
exit 1
`);
  chmodSync(cargo, 0o755);
  return directory;
}

test('make rust-repeat names each test when it starts, reports its result and elapsed time, and kills a test at its limit', (t) => {
  const directory = fakeCargo(t);
  const result = spawnSync('make', ['rust-repeat', 'PACKAGE=fixture', 'COUNT=1', 'TEST_TIMEOUT=2'], {
    cwd: root, env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}` }, encoding: 'utf8', timeout: 60000,
  });
  assert.match(result.stdout, /^RUN  fixture::alpha \(1 running, limit 2\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS fixture::alpha \d+\.\d{3}s$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^RUN  fixture::beta \(1 running, limit 2\.000s\)$/m, result.stdout + result.stderr);
  assert.match(result.stdout, /^TIME fixture::beta \d+\.\d{3}s exceeded 2\.000s and was killed$/m, result.stdout + result.stderr);
  const killed = /^TIME fixture::beta (\d+)\.\d{3}s/m.exec(result.stdout);
  assert.ok(killed && Number(killed[1]) < 6, `beta ran to its own sleep instead of its limit: ${result.stdout}`);
  // make exits with status 2 when a recipe fails; the run fails with the FAIL line of the runner.
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAIL: fixture run 1 of 1; load /m, result.stdout + result.stderr);
});

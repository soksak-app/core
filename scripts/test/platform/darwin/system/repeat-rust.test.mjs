// Verifies that the Rust owner CLI and `make repeat-rust` fail a test build whose link reports an object built for a newer macOS version
// than the link. The fixture crate `linkwarn` passes the macOS deployment flag to its C compiler in its build script, and the macOS
// linker reports the object, so the test needs the macOS toolchain. The fixture is a workspace of its own and is built by the real cargo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../../../../..');
const manifest = 'scripts/test/fixtures/repeat-rust/Cargo.toml';
const build = (name) => `scripts/test/fixtures/repeat-rust/${name}/Cargo.toml`;

/** A folder that holds the Cargo target of one test, removed when the test ends. */
function targetFolder(t) {
  const directory = mkdtempSync(join(tmpdir(), 'soksak-rust-repeat-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Runs `make` in the repository root with the Cargo target of the test and the manifest of the fixture (or of `file`). */
function make(t, args, { file = manifest, env = {} } = {}) {
  const target = targetFolder(t);
  const result = spawnSync('make', [...args, `MANIFEST=${file}`], {
    cwd: root, env: { ...process.env, CARGO_TARGET_DIR: target, ...env }, encoding: 'utf8', timeout: 240000,
  });
  return { ...result, target };
}

test('Rust owner CLI fails a test build whose link reports an object newer than the link, and names the object and both versions', { timeout: 240000 }, (t) => {
  const result = make(t, ['repeat-rust', 'PACKAGE=linkwarn', 'COUNT=1', 'TEST_TARGET=lib'], { file: build('linkwarn') });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /ld built \S+ for macOS 27\.0, newer than the macOS 14\.4 of the link/, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /^RUN  /m, 'a test of a build with a linker failure ran');
});

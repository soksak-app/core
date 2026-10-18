// Checks that the temporary-folder audit names the soksak- entries that a command leaves and passes a command that leaves none.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { audit, leftovers } from '../temp-audit.mjs';

function parent(t) {
  const folder = mkdtempSync(join(tmpdir(), 'temp-audit-test-'));
  t.after(() => rmSync(folder, { recursive: true }));
  return folder;
}

test('the leftovers are the soksak- entries except the window-check configuration folders', () => {
  assert.deepEqual(leftovers(['soksak-b-1', 'soksak-check-tauriv2', 'other', 'soksak-a-1.event-offsets', 'soksak-check-x.event-offsets']),
    ['soksak-a-1.event-offsets', 'soksak-b-1']);
});

test('a command that leaves a soksak- folder fails the audit and the folder is named', { timeout: 10000 }, (t) => {
  const lines = [];
  const status = audit('/bin/sh', ['-c', 'mkdir "$TMPDIR/soksak-left-1" "$TMPDIR/soksak-check-kept"'], { write: (line) => lines.push(line), parent: parent(t) });
  assert.equal(status, 1);
  assert.equal(lines.filter((line) => line.startsWith('TEMP LEFT ')).length, 1);
  assert.match(lines[0], /^TEMP LEFT .*\/temp-audit-[^/]+\/soksak-left-1$/);
  assert.match(lines.at(-1), /^TEMP FAIL \/bin\/sh .* left 1 soksak- entries/);
});

test('a command that removes its folders passes and the audit removes its own folder', { timeout: 10000 }, (t) => {
  const lines = [];
  const where = parent(t);
  const status = audit('/bin/sh', ['-c', 'mkdir "$TMPDIR/soksak-done-1" && rmdir "$TMPDIR/soksak-done-1"'], { write: (line) => lines.push(line), parent: where });
  assert.equal(status, 0);
  assert.match(lines.at(-1), /^TEMP PASS /);
  assert.deepEqual(readdirSync(where), []);
});

test('a command that fails fails the audit with its status', { timeout: 10000 }, (t) => {
  const lines = [];
  assert.equal(audit('/bin/sh', ['-c', 'exit 3'], { write: (line) => lines.push(line), parent: parent(t) }), 1);
  assert.equal(lines.at(-1), 'TEMP /bin/sh -c exit 3 exited with 3');
});

test('a command that cannot start is an error that names it', { timeout: 10000 }, (t) => {
  const where = parent(t);
  assert.throws(() => audit(join(where, 'missing'), [], { write: () => {}, parent: where }), /^Error: temp-audit: .*missing could not start: /);
  assert.equal(existsSync(join(where, 'missing')), false);
});

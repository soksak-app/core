// A watch that reports dropped events continues, and the state of the folder must be read again (F486). The FSEvents backend
// of @parcel/watcher reports `... File system must be re-scanned.` for an event with kFSEventStreamEventFlagMustScanSubDirs and
// keeps the callbacks of the watch, while a failure of the backend removes them. The test delivers both reports through the fault point of the watch
// (watchFault.start of folder-wait.mjs) and requires that the wait reads the state again on the first and rejects on the second.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { endWatches, untilFolderState, watchFault } from "../folder-wait.mjs";

// The fault point watchFault.start of folder-wait.mjs gives the test the function that delivers a report to the watch of the wait
// as the callback of @parcel/watcher does; the watch itself is the real one on the folder of the test.
let report = () => {};
watchFault.start = ({ report: deliver }) => { report = deliver; };
test.after(() => { watchFault.start = null; });

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "folder-wait-rescan-"));
  t.after(async () => {
    const ended = await endWatches();
    rmSync(dir, { recursive: true, force: true });
    if (ended.length) throw ended[0];
  });
  return dir;
}

/** A read that tells when it first ran, which is after the watch is active, and the promise of that first read. */
function activation(read) {
  let active = () => {};
  const activated = new Promise((resolve) => { active = resolve; });
  return { activated, read: () => { active(); return read(); } };
}

test("a wait reads the folder again when the watch reports dropped events", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  const file = join(dir, "state");
  const { activated, read } = activation(() => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined));
  const waiting = untilFolderState(dir, read);
  await activated;
  writeFileSync(file, '{"ready":true}');
  report(new Error("Events were dropped by the FSEvents client. File system must be re-scanned."));
  assert.deepEqual(await waiting, { ready: true });
});

test("a wait rejects when the watch fails", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  const { activated, read } = activation(() => undefined);
  const waiting = untilFolderState(dir, read);
  await activated;
  report(new Error("Unable to watch the folder"));
  await assert.rejects(waiting, /Unable to watch the folder/);
});

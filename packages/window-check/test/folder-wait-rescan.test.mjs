// A watch that reports dropped events continues, and the state of the folder must be read again (F486). The FSEvents backend
// of @parcel/watcher reports `... File system must be re-scanned.` for an event with kFSEventStreamEventFlagMustScanSubDirs and
// keeps the callbacks of the watch, while a failure of the backend removes them. The test injects both reports at
// @parcel/watcher and requires that the wait reads the state again on the first and rejects on the second.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

let report = () => {};
mock.module("@parcel/watcher", {
  namedExports: {
    subscribe: async (folder, callback) => {
      report = callback;
      return { unsubscribe: async () => {} };
    },
  },
});

const { untilFolderState } = await import("../folder-wait.mjs");

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "folder-wait-rescan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Lets the subscription settle and the first read run.
async function turns() {
  for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
}

test("a wait reads the folder again when the watch reports dropped events", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  const file = join(dir, "state");
  const waiting = untilFolderState(dir, () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined));
  await turns();
  writeFileSync(file, '{"ready":true}');
  report(new Error("Events were dropped by the FSEvents client. File system must be re-scanned."));
  assert.deepEqual(await waiting, { ready: true });
});

test("a wait rejects when the watch fails", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  const waiting = untilFolderState(dir, () => undefined);
  await turns();
  report(new Error("Unable to watch the folder"));
  await assert.rejects(waiting, /Unable to watch the folder/);
});

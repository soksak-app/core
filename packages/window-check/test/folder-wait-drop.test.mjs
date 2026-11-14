// FSEvents marks a batch after events were lost, and the backend of @parcel/watcher passes that to its callback as an error
// while its stream keeps running. The reports injected into FSEvents run in platform/darwin/system/folder-wait-drop.test.mjs;
// the tests of the other errors deliver them through the fault point of the watch in this process.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { endWatches, untilFolderState, watchFault } from "../folder-wait.mjs";

// The fault point watchFault.start of folder-wait.mjs gives the test the function that delivers an error to the watch of the wait,
// as the callback of @parcel/watcher does; the watch itself is the real one on a real folder.
let reportOfWatch = () => {};
watchFault.start = ({ report }) => { reportOfWatch = report; };

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "folder-wait-drop-"));
  t.after(async () => {
    const ended = await endWatches();
    rmSync(dir, { recursive: true, force: true });
    if (ended.length) throw ended[0];
  });
  return dir;
}

test.after(() => { watchFault.start = null; });

test("an error of the watch that does not ask for a scan rejects the wait", { timeout: 10000 }, async (t) => {
  const ended = new Error("Buffer overflow. Some events may have been lost.");
  const waiting = untilFolderState(folder(t), () => {
    queueMicrotask(() => reportOfWatch(ended));
    return undefined;
  });
  await assert.rejects(waiting, ended);
});

test("a report of lost events without a state rejects no wait and reads the folder once more", { timeout: 10000 }, async (t) => {
  let reads = 0;
  const waiting = untilFolderState(folder(t), () => {
    reads += 1;
    if (reads === 2) return reads;
    queueMicrotask(() => reportOfWatch(new Error("Too many events. File system must be re-scanned.")));
    return undefined;
  });
  assert.equal(await waiting, 2);
});

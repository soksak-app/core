// FSEvents marks a batch after events were lost, and the backend of @parcel/watcher passes that to its callback as an error
// while its stream keeps running. The reports injected into FSEvents run in platform/darwin/system/folder-wait-drop.test.mjs;
// the tests of the other errors replace the watcher in this process.
import assert from "node:assert/strict";
import test, { mock } from "node:test";

let reportOfWatch = () => {};
mock.module("@parcel/watcher", {
  namedExports: {
    subscribe: async (_folder, callback) => {
      reportOfWatch = callback;
      return { unsubscribe: async () => {} };
    },
  },
});

const { untilFolderState } = await import("../folder-wait.mjs");

test("an error of the watch that does not ask for a scan rejects the wait", { timeout: 10000 }, async () => {
  const ended = new Error("Buffer overflow. Some events may have been lost.");
  const waiting = untilFolderState("/watched", () => {
    queueMicrotask(() => reportOfWatch(ended));
    return undefined;
  });
  await assert.rejects(waiting, ended);
});

test("a report of lost events without a state rejects no wait and reads the folder once more", { timeout: 10000 }, async () => {
  let reads = 0;
  const waiting = untilFolderState("/watched", () => {
    reads += 1;
    if (reads === 2) return reads;
    queueMicrotask(() => reportOfWatch(new Error("Too many events. File system must be re-scanned.")));
    return undefined;
  });
  assert.equal(await waiting, 2);
});

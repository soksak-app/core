// A folder wait settles also when its watch does not start or does not end (F485), and no time ends it: its state or the
// abort of its signal settles it, and endWatches ends when every watch end has answered. At a high load of the file system
// events service the subscription and its end of @parcel/watcher can take minutes; the tests hold them (fault injection at
// @parcel/watcher: neither promise settles unless the test releases it) and require that the wait settles at its state or
// its abort, and that endWatches ends only when the held watch end answered and reports a watch end that failed once.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

let startWatch = () => {};
let endWatch = () => {};
let failEnd = () => {};
let subscriptions = 0;
mock.module("@parcel/watcher", {
  namedExports: {
    subscribe: () => new Promise((resolve) => {
      subscriptions += 1;
      startWatch = () => resolve({ unsubscribe: () => new Promise((ended, failed) => { endWatch = ended; failEnd = failed; }) });
    }),
  },
});

const { endWatches, untilFolderState } = await import("../folder-wait.mjs");

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "folder-wait-bound-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function turns() {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
}

// The outcome of `promise` after the promise callbacks ran: "pending", the value, or the message of its error.
async function outcome(promise) {
  let result = "pending";
  promise.then((value) => { result = value; }, (error) => { result = error.message; });
  await turns();
  return result;
}

test("a wait whose watch does not start settles at the abort of its signal, and endWatches ends after the watch ended", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  const host = new AbortController();
  const waiting = untilFolderState(dir, () => undefined, { signal: host.signal });
  assert.equal(await outcome(waiting), "pending", "a wait settled while its watch did not start");
  host.abort(new Error("the host ended"));
  assert.equal(await outcome(waiting), "the host ended", "the abort did not settle a wait whose watch did not start");
  const ended = endWatches();
  assert.equal(await outcome(ended), "pending", "endWatches ended while a watch had not started");
  startWatch();
  await turns();
  endWatch();
  assert.deepEqual(await ended, []);
});

test("a wait whose watch does not end settles with its value, and endWatches reports the failed end once", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  const waiting = untilFolderState(dir, () => 1);
  startWatch();
  assert.equal(await outcome(waiting), 1, "a wait whose value was read did not settle while its watch did not end");
  const ended = endWatches();
  assert.equal(await outcome(ended), "pending", "endWatches ended while a watch end had not answered");
  failEnd(new Error("stream stop failed"));
  assert.deepEqual((await ended).map((error) => error.message), [`the watch of ${dir} failed to end: stream stop failed`]);
  assert.deepEqual(await endWatches(), [], "a watch end was reported twice");
});

test("a watch of a folder starts after the end of the earlier watch of that folder answered", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  const first = untilFolderState(dir, () => 1);
  startWatch();
  assert.equal(await outcome(first), 1, "the first wait did not settle with its value");
  const started = subscriptions;
  const second = untilFolderState(dir, () => 2);
  await turns();
  assert.equal(subscriptions, started, "a watch of the folder started while the end of its earlier watch had not answered");
  endWatch();
  await turns();
  assert.equal(subscriptions, started + 1, "the watch of the folder did not start after the end of its earlier watch answered");
  startWatch();
  assert.equal(await outcome(second), 2, "the second wait did not settle with its value");
  endWatch();
  assert.deepEqual(await endWatches(), []);
});

test("endWatches and a folder wait take no limit", async () => {
  await assert.rejects(endWatches(50), /^TypeError: endWatches takes no limit/);
  await assert.rejects(untilFolderState("/watched", () => 1, 100), /^TypeError: untilFolderState takes no timeout/);
  await assert.rejects(untilFolderState("/watched", () => 1, { timeout: 100 }), /^TypeError: untilFolderState takes no timeout/);
});

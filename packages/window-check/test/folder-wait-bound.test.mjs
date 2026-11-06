// The deadline of a folder wait bounds the wait also when the watch does not start or does not end (F485). At a high load
// of the file system events service the subscription and its end of @parcel/watcher can take minutes; the tests hold them
// (fault injection at @parcel/watcher: neither promise settles unless the test releases it) and require that the wait
// settles at its deadline and that the watch end that has not finished is reported by endWatches.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

let subscription = "held";
let endWatch = () => {};
mock.module("@parcel/watcher", {
  namedExports: {
    subscribe: () => new Promise((resolve) => {
      if (subscription === "held") return;
      resolve({ unsubscribe: () => new Promise((ended) => { endWatch = ended; }) });
    }),
  },
});

const { endWatches, untilFolderState } = await import("../folder-wait.mjs");

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "folder-wait-bound-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Moves the clock past the deadline and lets the promise callbacks run without a timer.
async function pastDeadline(t, waiting) {
  let outcome = "pending";
  waiting.then(() => { outcome = "resolved"; }, (error) => { outcome = error.message; });
  t.mock.timers.tick(100);
  await turns();
  return outcome;
}

async function turns() {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
}

// Ends the watches with a limit of 50 ms that the test moves the clock past.
async function ended(t) {
  const failures = endWatches(50);
  await turns();
  t.mock.timers.tick(50);
  return (await failures).map((error) => error.message);
}

test("a wait whose watch does not start settles at its deadline and reports the watch", { timeout: 10000 }, async (t) => {
  subscription = "held";
  const dir = folder(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const outcome = await pastDeadline(t, untilFolderState(dir, () => undefined, 100, () => new Error("deadline passed")));
  assert.equal(outcome, "deadline passed", "the deadline did not settle a wait whose watch did not start");
  assert.deepEqual(await ended(t), [`the watch of ${dir} did not end within 50 ms after its wait`]);
  assert.deepEqual(await ended(t), [], "a watch end was reported twice");
});

test("a wait whose watch does not end settles with its value and reports the watch", { timeout: 10000 }, async (t) => {
  subscription = "started";
  const dir = folder(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const outcome = await pastDeadline(t, untilFolderState(dir, () => (++reads >= 1 ? reads : undefined), 100, () => new Error("deadline passed")));
  assert.equal(outcome, "resolved", "a wait whose value was read did not settle while its watch did not end");
  assert.deepEqual(await ended(t), [`the watch of ${dir} did not end within 50 ms after its wait`]);
  endWatch();
  await turns();
  assert.deepEqual(await ended(t), [], "a watch that ended later was reported again");
});

import assert from "node:assert/strict";
import test from "node:test";
import { createLayoutQueue, nextTask } from "../layout-queue.js";

// The failure is reported by failed, so the reply of the request gives only the failed state and does not reject with that failure again (docs/spec/hosts.md#application-log).
test("a failed presentation answers its request as failed, reports failure, and permits the next drag", async () => {
  const reported = [];
  const queue = createLayoutQueue({ failed: (error) => reported.push(error), superseded: assert.fail });
  const failure = new Error("current image raster did not present");
  const first = queue.run(() => { throw failure; });
  assert.deepEqual(await first, { status: "failed" });
  assert.equal(await queue.wait(), false, "the wait must end without the failure that failed already reported");
  let drawn = 0;
  await queue.run(() => { drawn++; });
  assert.equal(await queue.wait(), true);
  assert.equal(drawn, 1);
  assert.deepEqual(reported, [failure]);
});

test("a string presentation failure keeps its measured reason", async () => {
  const errors = [];
  const queue = createLayoutQueue({ failed: (error) => errors.push(String(error?.message ?? error)) });
  assert.deepEqual(await queue.run(() => Promise.reject("current image raster did not present within 10s")), { status: "failed" });
  assert.deepEqual(errors, ["current image raster did not present within 10s"]);
});

test("a new layout cannot run before the active presentation finishes", async () => {
  const queue = createLayoutQueue({ failed: assert.fail, superseded: assert.fail });
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const calls = [];
  const first = queue.run(async () => { calls.push(1); await gate; calls.push(2); });
  const second = queue.run(() => { calls.push(3); });
  await Promise.resolve();
  assert.deepEqual(calls, [1]);
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(calls, [1, 2, 3]);
});

test("a newer waiting layout replaces the older waiting layout and reports it", async () => {
  const superseded = [];
  const queue = createLayoutQueue({ failed: assert.fail, superseded: (work) => superseded.push(work) });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const first = queue.run(async () => { calls.push("first"); await gate; });
  const old = () => { calls.push("old"); };
  const replaced = queue.run(old);
  const newest = queue.run(() => { calls.push("new"); return "new"; });
  release();
  await first;
  assert.deepEqual(await replaced, { status: "superseded" });
  assert.equal(await newest, "new");
  assert.deepEqual(calls, ["first", "new"]);
  assert.deepEqual(superseded, [old]);
});

// A preparation reply can be fulfilled at any microtask checkpoint, so the drawing runs in the next task, not at that checkpoint.
// A task does not run between a rendering update and its observation round, and it does not wait for a screen update the way an animation frame does (F43, F92).
test("a prepared draw runs in the next task, not in the checkpoint that answered its preparation", { timeout: 5000 }, async () => {
  const calls = [];
  const waiting = nextTask(() => calls.push("work"));
  for (let checkpoint = 0; checkpoint < 5; checkpoint++) await Promise.resolve();
  assert.deepEqual(calls, [], "the work ran in the microtask checkpoint that scheduled it");
  await waiting;
  assert.deepEqual(calls, ["work"]);
});

test("a prepared draw that throws fails its task wait with that error", { timeout: 5000 }, async () => {
  await assert.rejects(nextTask(() => { throw new Error("injected draw failure"); }), /injected draw failure/);
});

// While a layout scheduled by an earlier tab close is awaited, the next tab close releases a surface and schedules a newer layout. The awaited layout
// is not drawn and is replaced. When the wait ends then, the slot of the released surface is still in the document (F50).
test("the wait for the drawn layout continues through a layout that a newer layout replaces", async () => {
  const queue = createLayoutQueue({ failed: assert.fail, superseded: () => {} });
  let slots = ["tab-a", "tab-b"];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const active = queue.run(async () => { await gate; });
  // The layout that the first close scheduled after it released tab-a.
  queue.run(() => { slots = ["tab-b"]; });
  let read = null;
  const waiting = queue.wait().then(() => { read = slots; });
  // The layout that the next close scheduled after it released tab-b replaces the awaited layout.
  const newest = queue.run(() => { slots = []; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(read, null, `the wait ended before the newest layout drew and read ${JSON.stringify(read)}`);
  release();
  await Promise.all([active, newest, waiting]);
  assert.deepEqual(read, []);
});

// The failure of the newest layout is reported by failed. The wait does not receive that failure again and answers only that the layout was not drawn.
test("the wait for the drawn layout answers false when the newest layout failed", async () => {
  const failure = new Error("current image raster did not present");
  const reported = [];
  const queue = createLayoutQueue({ failed: (error) => reported.push(error), superseded: () => {} });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = queue.run(async () => { await gate; throw new Error("replaced presentation failed"); });
  const waiting = queue.wait();
  const newest = queue.run(() => { throw failure; });
  release();
  assert.deepEqual(await first, { status: "failed" });
  assert.deepEqual(await newest, { status: "failed" });
  assert.equal(await waiting, false);
  assert.deepEqual(reported.map((error) => error.message), ["replaced presentation failed", failure.message]);
});

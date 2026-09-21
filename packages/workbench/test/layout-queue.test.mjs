import assert from "node:assert/strict";
import test from "node:test";
import { createLayoutQueue } from "../layout-queue.js";

test("a failed presentation rejects its request, reports failure, and permits the next drag", async () => {
  const reported = [];
  const queue = createLayoutQueue({ failed: (error) => reported.push(error) });
  const failure = new Error("current image raster did not present");
  const first = queue.run(() => { throw failure; });
  await assert.rejects(first, (error) => error === failure);
  await assert.rejects(queue.wait(), (error) => error === failure);
  let drawn = 0;
  await queue.run(() => { drawn++; });
  await queue.wait();
  assert.equal(drawn, 1);
  assert.deepEqual(reported, [failure]);
});

test("a new layout cannot run before the active presentation finishes", async () => {
  const queue = createLayoutQueue({ failed: assert.fail });
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

test("pending layouts run in order without dropping a user-visible state", async () => {
  const queue = createLayoutQueue({ failed: assert.fail });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = queue.run(async () => { await gate; });
  const old = () => "old";
  const replacement = queue.run(old);
  const newest = queue.run(() => "new");
  release();
  await first;
  assert.equal(await replacement, "old");
  assert.equal(await newest, "new");
});

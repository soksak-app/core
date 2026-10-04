import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { animationFrame, createLayoutQueue } from "../layout-queue.js";

test("a failed presentation rejects its request, reports failure, and permits the next drag", async () => {
  const reported = [];
  const queue = createLayoutQueue({ failed: (error) => reported.push(error), superseded: assert.fail });
  const failure = new Error("current image raster did not present");
  const first = queue.run(() => { throw failure; });
  await assert.rejects(first, (error) => error === failure);
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
  await assert.rejects(queue.run(() => Promise.reject("current image raster did not present within 10s")));
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

test("an animation frame wait fails with its own error when the document runs no frame", { timeout: 5000 }, async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  let settled = null;
  const waiting = animationFrame(() => {}).then(() => { settled = "frame"; }, (error) => { settled = error; });
  mock.timers.tick(9999);
  await Promise.resolve();
  assert.equal(settled, null, "the frame wait failed before 10 seconds");
  mock.timers.tick(1);
  await waiting;
  assert.ok(settled instanceof Error && /the main document ran no animation frame within 10000ms/.test(settled.message),
    String(settled));
});

test("an animation frame wait resolves on the next frame", { timeout: 5000 }, async () => {
  let frame;
  const waiting = animationFrame((callback) => { frame = callback; });
  frame(16.7);
  await waiting;
});

// 앞선 탭 닫기가 예약한 배치를 기다리는 동안 다음 탭 닫기가 표면을 해제하고 더 새 배치를 예약하면, 기다리던 배치는
// 그리지 않고 대신된다. 기다림이 그때 끝나면 해제된 표면의 슬롯이 아직 문서에 있다(F50).
test("the wait for the drawn layout continues through a layout that a newer layout replaces", async () => {
  const queue = createLayoutQueue({ failed: assert.fail, superseded: () => {} });
  let slots = ["tab-a", "tab-b"];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const active = queue.run(async () => { await gate; });
  // 첫 닫기가 tab-a 를 해제하고 예약한 배치.
  queue.run(() => { slots = ["tab-b"]; });
  let read = null;
  const waiting = queue.wait().then(() => { read = slots; });
  // 다음 닫기가 tab-b 를 해제하고 예약한 배치가 기다리던 배치를 대신한다.
  const newest = queue.run(() => { slots = []; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(read, null, `the wait ended before the newest layout drew and read ${JSON.stringify(read)}`);
  release();
  await Promise.all([active, newest, waiting]);
  assert.deepEqual(read, []);
});

// 가장 새 배치의 실패는 failed 가 보고한다. 기다림은 그 실패를 다시 받지 않고, 그 배치가 그려지지 않았음만 답한다.
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
  await assert.rejects(first);
  await assert.rejects(newest);
  assert.equal(await waiting, false);
  assert.deepEqual(reported.map((error) => error.message), ["replaced presentation failed", failure.message]);
});

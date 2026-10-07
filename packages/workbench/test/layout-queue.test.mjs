import assert from "node:assert/strict";
import test from "node:test";
import { createLayoutQueue, nextTask } from "../layout-queue.js";

// 실패는 failed 가 보고하므로 요청의 답은 그 실패를 다시 거절로 주지 않고 실패한 상태만 준다(docs/spec/hosts.md#application-log).
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

// 준비 응답은 어느 microtask checkpoint 에서든 이행될 수 있으므로 그리기는 그 checkpoint 가 아니라 다음 task 에서 실행한다.
// task 는 렌더링 갱신과 그 관찰 round 사이에 실행되지 않고, animation frame 처럼 화면 갱신을 기다리지도 않는다(F43, F92).
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
  assert.deepEqual(await first, { status: "failed" });
  assert.deepEqual(await newest, { status: "failed" });
  assert.equal(await waiting, false);
  assert.deepEqual(reported.map((error) => error.message), ["replaced presentation failed", failure.message]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createLayoutQueue, drawPrepared } from "../layout-queue.js";

// 문서가 배치마다 대기열에 넣는 그리기 순서를 가짜 준비·그리기·표시로 실행한다.
function fixture() {
  const calls = [];
  const errors = [];
  const frames = [];
  const prepared = Promise.withResolvers();
  const presented = Promise.withResolvers();
  const drawn = Promise.withResolvers();
  const context = { layoutEpoch: 0 };
  const layouts = createLayoutQueue({ failed: error => errors.push(error), superseded: assert.fail });
  const run = () => {
    const epoch = context.layoutEpoch;
    return layouts.run(() => drawPrepared({
      epoch, current: () => context.layoutEpoch,
      prepare: () => { calls.push("prepare"); return prepared.promise; },
      draw: () => { calls.push("draw"); drawn.resolve(); },
      frame: (work) => new Promise((resolve) => frames.push(() => { work(); resolve(); })),
      presented: () => presented.promise,
    }));
  };
  const frame = () => { for (const callback of frames.splice(0)) callback(); };
  return { calls, errors, prepared, presented, drawn, context, run, frame };
}

test("the document waits for native preparation before drawing and retains the presentation barrier", { timeout: 1000 }, async () => {
  const f = fixture();
  const done = f.run();
  await Promise.resolve();
  assert.deepEqual(f.calls, ["prepare"], "the document drew before native preparation answered");
  f.prepared.resolve([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls, ["prepare"], "the document drew before the animation frame");
  let completed = false;
  done.then(() => { completed = true; });
  f.frame(); await f.drawn.promise; await Promise.resolve();
  assert.deepEqual(f.calls, ["prepare", "draw"]);
  assert.equal(completed, false, "the layout queue released before matching presentation");
  f.presented.resolve(); await done;
  assert.equal(completed, true);
  assert.deepEqual(f.errors, []);
});

test("a rejected native preparation reports failure without drawing the document", async () => {
  const f = fixture();
  const done = f.run();
  const failure = new Error("injected native preparation rejection");
  await Promise.resolve();
  f.frame();
  f.prepared.reject(failure);
  assert.deepEqual(await done, { status: "failed" });
  assert.deepEqual(f.calls, ["prepare"], "a rejected preparation changed the document");
  assert.deepEqual(f.errors, [failure]);
});

test("a changed layout epoch cancels an old draw after pending native preparation", async () => {
  const f = fixture();
  const done = f.run();
  await Promise.resolve();
  f.context.layoutEpoch++;
  f.prepared.resolve([]);
  f.frame(); f.presented.resolve();
  await done;
  assert.deepEqual(f.calls, ["prepare"], "an old preparation drew into the replacement layout");
  assert.deepEqual(f.errors, []);
});

// WebKit 의 관찰 round 는 callback 마다 microtask checkpoint 를 실행하고, 그 뒤 이미 전달한 깊이 이하의 요소 크기가
// 바뀌었으면 그 관찰을 다음 frame 으로 미루고 loop 오류를 낸다. 준비 응답이 그 checkpoint 에서 이행되어도 그리기는
// 다음 animation frame 에서 실행되어야 한다. 그 frame 은 다음 관찰 round 보다 먼저 실행된다(F43).
test("a prepared draw runs at the next animation frame when its preparation is answered inside an observation round", async () => {
  const frames = [];
  const answered = Promise.withResolvers();
  // 판을 비우면 파일 트리를 담은 카드가 사라지고 트리 컨테이너의 크기가 0 이 된다.
  const tree = { height: 498 };
  const layouts = createLayoutQueue({ failed: assert.fail, superseded: assert.fail });
  const done = layouts.run(() => drawPrepared({
    epoch: 0, current: () => 0,
    prepare: () => answered.promise,
    draw: () => { tree.height = 0; },
    frame: (work) => new Promise((resolve) => frames.push(() => { work(); resolve(); })),
    presented: async () => {},
  }));
  await new Promise((resolve) => setImmediate(resolve));
  // 관찰 round: 트리 observer 의 callback 이 높이 498 을 전달받고, 그 checkpoint 에서 준비 응답이 이행된다.
  let delivered = null;
  const callback = () => {
    delivered = tree.height;
    answered.resolve([]);
  };
  callback();
  await new Promise((resolve) => setImmediate(resolve));
  // round 의 다음 수집: 전달한 깊이의 트리 컨테이너 크기가 바뀌었으면 WebKit 은 그 관찰을 미룬다.
  assert.equal(tree.height, delivered, "the draw changed the tree container inside the observation round");
  for (const run of frames.splice(0)) run();
  await done;
  assert.equal(tree.height, 0, "the draw did not run at the animation frame");
});

test("a changed layout epoch cancels a draw that waits for its animation frame", async () => {
  const f = fixture();
  const done = f.run();
  f.prepared.resolve([]);
  await new Promise((resolve) => setImmediate(resolve));
  f.context.layoutEpoch++;
  f.frame();
  await done;
  assert.deepEqual(f.calls, ["prepare"], "an old layout drew into the replacement layout at its frame");
  assert.deepEqual(f.errors, []);
});

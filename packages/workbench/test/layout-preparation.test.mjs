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
      frame: () => new Promise((resolve) => frames.push(resolve)),
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
  await f.drawn.promise;
  assert.deepEqual(f.calls, ["prepare", "draw"]);
  let completed = false;
  done.then(() => { completed = true; });
  f.frame(); await Promise.resolve();
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

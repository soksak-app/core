import assert from "node:assert/strict";
import test from "node:test";
import { createLayoutQueue, drawPrepared } from "../layout-queue.js";
import { drained } from "./support/drained.mjs";

// Runs the drawing order that the document queues for each layout. The test passes the preparation, drawing, frame and presentation steps
// that drawPrepared takes as parameters and settles each one at the point that its assertions name.
function fixture() {
  const calls = [];
  const errors = [];
  const frames = [];
  const prepared = Promise.withResolvers();
  const presented = Promise.withResolvers();
  const drawn = Promise.withResolvers();
  // Each arrival resolves when drawPrepared calls its step: the preparation, the frame request and the presentation request.
  const preparing = Promise.withResolvers();
  const framing = Promise.withResolvers();
  const presenting = Promise.withResolvers();
  const context = { layoutEpoch: 0 };
  const layouts = createLayoutQueue({ failed: error => errors.push(error), superseded: assert.fail });
  const run = () => {
    const epoch = context.layoutEpoch;
    return layouts.run(() => drawPrepared({
      epoch, current: () => context.layoutEpoch,
      prepare: () => { calls.push("prepare"); preparing.resolve(); return prepared.promise; },
      draw: () => { calls.push("draw"); drawn.resolve(); },
      frame: (work) => new Promise((resolve) => { frames.push(() => { work(); resolve(); }); framing.resolve(); }),
      presented: () => { presenting.resolve(); return presented.promise; },
      cancel: async () => { calls.push("cancel"); },
    }));
  };
  const frame = () => { for (const callback of frames.splice(0)) callback(); };
  return { calls, errors, prepared, presented, drawn, preparing, framing, presenting, context, layouts, run, frame };
}

test("the document waits for native preparation before drawing and retains the presentation barrier", { timeout: 1000 }, async () => {
  const f = fixture();
  const done = f.run();
  await f.preparing.promise;
  assert.deepEqual(f.calls, ["prepare"], "the document drew before native preparation answered");
  f.prepared.resolve([]);
  await f.framing.promise;
  assert.deepEqual(f.calls, ["prepare"], "the document drew before its draw task");
  let completed = false;
  done.then(() => { completed = true; });
  let nextStarted = false;
  const next = f.layouts.run(() => { nextStarted = true; });
  f.frame(); await f.drawn.promise;
  // The presentation is requested after the draw. Until it resolves, the layout and the next layout cannot complete. The queue
  // completes a layout and starts the next one in microtasks, so after the end of the microtask queue a layout that did not wait
  // for the presentation has completed.
  await f.presenting.promise;
  await drained();
  try {
    assert.deepEqual(f.calls, ["prepare", "draw"]);
    assert.equal(completed, false, "the layout queue released before matching presentation");
    assert.equal(nextStarted, false, "the next layout started before matching presentation");
  } finally {
    f.presented.resolve();
    await done;
    await next;
  }
  assert.equal(completed, true);
  assert.equal(nextStarted, true);
  assert.deepEqual(f.errors, []);
});

test("a rejected native preparation reports failure without drawing the document", async () => {
  const f = fixture();
  const done = f.run();
  const failure = new Error("injected native preparation rejection");
  await f.preparing.promise;
  f.frame();
  f.prepared.reject(failure);
  assert.deepEqual(await done, { status: "failed" });
  assert.deepEqual(f.calls, ["prepare", "cancel"], "a rejected preparation changed the document or left a handed-over transaction open");
  assert.deepEqual(f.errors, [failure]);
});

test("a changed layout epoch cancels an old draw after pending native preparation", async () => {
  const f = fixture();
  const done = f.run();
  await f.preparing.promise;
  f.context.layoutEpoch++;
  f.prepared.resolve([]);
  f.frame(); f.presented.resolve();
  await done;
  assert.deepEqual(f.calls, ["prepare", "cancel"], "an old preparation drew into the replacement layout or stayed open");
  assert.deepEqual(f.errors, []);
});

// An observation round of WebKit runs a microtask checkpoint after each callback. If the size of an element at or below the depth already delivered
// changed after that, WebKit defers the observation to the next frame and raises a loop error. Even when the preparation reply is fulfilled at that checkpoint, the drawing
// must run in the next task outside that round (F43).
test("a prepared draw runs after the observation round when its preparation is answered inside it", async () => {
  const frames = [];
  const answered = Promise.withResolvers();
  const preparing = Promise.withResolvers();
  const framing = Promise.withResolvers();
  // Clearing the plane removes the card that holds the file tree, and the size of the tree container becomes 0.
  const tree = { height: 498 };
  const layouts = createLayoutQueue({ failed: assert.fail, superseded: assert.fail });
  const done = layouts.run(() => drawPrepared({
    epoch: 0, current: () => 0,
    prepare: () => { preparing.resolve(); return answered.promise; },
    draw: () => { tree.height = 0; },
    frame: (work) => new Promise((resolve) => { frames.push(() => { work(); resolve(); }); framing.resolve(); }),
    presented: async () => {},
  }));
  await preparing.promise;
  // Observation round: the callback of the tree observer receives height 498, and the preparation reply is fulfilled at that checkpoint.
  let delivered = null;
  const callback = () => {
    delivered = tree.height;
    answered.resolve([]);
  };
  callback();
  // The draw is requested only after the round. A draw that ran inside the round would have changed the tree before this request.
  await framing.promise;
  // Next gathering of the round: when the size of the tree container at the delivered depth changed, WebKit defers that observation.
  assert.equal(tree.height, delivered, "the draw changed the tree container inside the observation round");
  for (const run of frames.splice(0)) run();
  await done;
  assert.equal(tree.height, 0, "the draw did not run in its task");
});

test("a changed layout epoch cancels a draw that waits for its task", async () => {
  const f = fixture();
  const done = f.run();
  f.prepared.resolve([]);
  await f.framing.promise;
  f.context.layoutEpoch++;
  f.frame();
  await done;
  assert.deepEqual(f.calls, ["prepare", "cancel"], "an old layout drew into the replacement layout at its frame or stayed open");
  assert.deepEqual(f.errors, []);
});

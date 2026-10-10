import assert from "node:assert/strict";
import test from "node:test";
import { createLayoutQueue, drawPrepared } from "../layout-queue.js";

// Runs the drawing order that the document queues for each layout with a fake preparation, drawing, and presentation.
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
  assert.deepEqual(f.calls, ["prepare"], "the document drew before its draw task");
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

// An observation round of WebKit runs a microtask checkpoint after each callback. If the size of an element at or below the depth already delivered
// changed after that, WebKit defers the observation to the next frame and raises a loop error. Even when the preparation reply is fulfilled at that checkpoint, the drawing
// must run in the next task outside that round (F43).
test("a prepared draw runs after the observation round when its preparation is answered inside it", async () => {
  const frames = [];
  const answered = Promise.withResolvers();
  // Clearing the plane removes the card that holds the file tree, and the size of the tree container becomes 0.
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
  // Observation round: the callback of the tree observer receives height 498, and the preparation reply is fulfilled at that checkpoint.
  let delivered = null;
  const callback = () => {
    delivered = tree.height;
    answered.resolve([]);
  };
  callback();
  await new Promise((resolve) => setImmediate(resolve));
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
  await new Promise((resolve) => setImmediate(resolve));
  f.context.layoutEpoch++;
  f.frame();
  await done;
  assert.deepEqual(f.calls, ["prepare"], "an old layout drew into the replacement layout at its frame");
  assert.deepEqual(f.errors, []);
});

import assert from "node:assert/strict";
import { createHook, executionAsyncId } from "node:async_hooks";
import test from "node:test";
import { createLayoutQueue, drawPrepared, nextTask } from "../layout-queue.js";

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
  const started = Promise.withResolvers();
  const first = queue.run(async () => { calls.push(1); started.resolve(); await gate; calls.push(2); });
  const second = queue.run(() => { calls.push(3); });
  // The second layout cannot start before the first ends, and the first ends only after the gate opens.
  await started.promise;
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
test("a prepared draw runs in the next task, not in the checkpoint that answered its preparation", { timeout: 5000 }, async (t) => {
  // The type of the resource whose callback runs the work: a message task runs it as MESSAGEPORT, a microtask as PROMISE or Microtask.
  const types = new Map();
  const hook = createHook({ init(id, type) { types.set(id, type); } }).enable();
  t.after(() => hook.disable());
  const calls = [];
  await nextTask(() => calls.push(types.get(executionAsyncId())));
  assert.deepEqual(calls, ["MESSAGEPORT"], "the work ran in a microtask checkpoint and not in a message task");
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
  const started = Promise.withResolvers();
  const active = queue.run(async () => { started.resolve(); await gate; });
  // The layout that the first close scheduled after it released tab-a.
  queue.run(() => { slots = ["tab-b"]; });
  let read = null;
  const waiting = queue.wait().then(() => { read = slots; });
  // The layout that the next close scheduled after it released tab-b replaces the awaited layout.
  const newest = queue.run(() => { slots = []; });
  // The wait awaits the newest layout, which runs only after the active layout ends at the gate.
  await started.promise;
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

// A preparation holds the layout transaction of its window, and other windows wait for that transaction, so it ends on every path.
test("a preparation whose draw fails is cancelled and the failure reaches the caller", { timeout: 1000 }, async () => {
  const calls = [];
  const failure = new Error("draw failed");
  await assert.rejects(drawPrepared({
    epoch: 1, current: () => 1,
    prepare: async () => { calls.push("prepare"); },
    draw: () => { throw failure; },
    frame: async (work) => work(),
    presented: async () => { calls.push("presented"); },
    cancel: async () => { calls.push("cancel"); },
  }), failure);
  assert.deepEqual(calls, ["prepare", "cancel"]);
});

test("a preparation that a newer layout replaced before its draw is cancelled", { timeout: 1000 }, async () => {
  for (const moved of ["prepare", "frame"]) {
    const calls = [];
    let current = 1;
    await drawPrepared({
      epoch: 1, current: () => current,
      prepare: async () => { calls.push("prepare"); if (moved === "prepare") current = 2; },
      draw: () => { calls.push("draw"); },
      frame: async (work) => { if (moved === "frame") current = 2; work(); },
      presented: async () => { calls.push("presented"); },
      cancel: async () => { calls.push("cancel"); },
    });
    assert.deepEqual(calls, ["prepare", "cancel"], `the epoch moved during ${moved}`);
  }
});

// A cancel that commits would show the native frames of the undrawn preparation over the DOM of the earlier layout (F484). An epoch
// change has queued the next layout, which places every surface again, so the cancel hands the open transaction to that layout.
test("a preparation that a newer layout replaced before its draw hands its transaction to the next layout", { timeout: 1000 }, async () => {
  for (const moved of ["prepare", "frame"]) {
    const cancels = [];
    let current = 1;
    await drawPrepared({
      epoch: 1, current: () => current,
      prepare: async () => { if (moved === "prepare") current = 2; },
      draw: assert.fail,
      frame: async (work) => { if (moved === "frame") current = 2; work(); },
      presented: assert.fail,
      cancel: async (options) => { cancels.push(options); },
    });
    assert.deepEqual(cancels, [{ handover: true }], `the epoch moved during ${moved}`);
  }
});

// The plane draws its current model, so a layout whose prepared seats no longer name the tabs that the cards show would draw other
// surfaces than the ones it placed, which V7c reports. The change that moved the seats queued the next layout, which takes over.
test("a preparation whose seats no longer hold before its draw hands its transaction to the next layout", { timeout: 1000 }, async () => {
  for (const moved of ["prepare", "frame"]) {
    const cancels = [];
    let holds = true;
    await drawPrepared({
      epoch: 1, current: () => 1, held: () => holds,
      prepare: async () => { if (moved === "prepare") holds = false; },
      draw: assert.fail,
      frame: async (work) => { if (moved === "frame") holds = false; work(); },
      presented: assert.fail,
      cancel: async (options) => { cancels.push(options); },
    });
    assert.deepEqual(cancels, [{ handover: true }], `the seats moved during ${moved}`);
  }
});

// A failed draw has no queued layout after it, so its cancel ends the transaction.
test("a preparation whose draw fails cancels its transaction without a handover", { timeout: 1000 }, async () => {
  const cancels = [];
  await assert.rejects(drawPrepared({
    epoch: 1, current: () => 1,
    prepare: async () => {},
    draw: () => { throw new Error("draw failed"); },
    frame: async (work) => work(),
    presented: assert.fail,
    cancel: async (options) => { cancels.push(options); },
  }), /draw failed/);
  assert.deepEqual(cancels, [{ handover: false }]);
});

// The next layout ends a handed-over transaction; when its preparation fails before the host begins it, the cancel ends it instead.
test("a preparation whose request fails cancels without a handover and the failure reaches the caller", { timeout: 1000 }, async () => {
  const cancels = [];
  const failure = new Error("preparation refused");
  await assert.rejects(drawPrepared({
    epoch: 1, current: () => 1,
    prepare: async () => { throw failure; },
    draw: assert.fail,
    frame: assert.fail,
    presented: assert.fail,
    cancel: async (options) => { cancels.push(options); },
  }), failure);
  assert.deepEqual(cancels, [{ handover: false }]);
});

test("a preparation that presents is not cancelled", { timeout: 1000 }, async () => {
  const calls = [];
  await drawPrepared({
    epoch: 1, current: () => 1,
    prepare: async () => { calls.push("prepare"); },
    draw: () => { calls.push("draw"); },
    frame: async (work) => work(),
    presented: async () => { calls.push("presented"); },
    cancel: async () => { calls.push("cancel"); },
  });
  assert.deepEqual(calls, ["prepare", "draw", "presented"]);
});

test("a failed cancellation is reported with the failure of the draw", { timeout: 1000 }, async () => {
  await assert.rejects(drawPrepared({
    epoch: 1, current: () => 1,
    prepare: async () => {},
    draw: () => { throw new Error("draw failed"); },
    frame: async (work) => work(),
    presented: assert.fail,
    cancel: async () => { throw new Error("cancel refused"); },
  }), /draw failed; cancelling layout: cancel refused/);
});

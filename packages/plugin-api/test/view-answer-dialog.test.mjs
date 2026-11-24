// Checks the route of the view calls runtime.dialog.open and runtime.dialog.close in answerViewCall (docs/spec/plugins.md#dialogs):
// the open call reaches the runtime with the name, the params and the signal of the call, which aborts when the call is cancelled,
// and the close call reaches the runtime with its result.
import assert from "node:assert/strict";
import test from "node:test";
import { answerViewCall } from "../view-answer.js";

/** The options of answerViewCall for a view whose runtime records each dialog call in calls and answers an open with open(). */
function optionsWith(calls, open = () => ({ saved: true })) {
  return {
    plugin: "probe",
    surface: "probe-surface",
    pending: new Map(),
    emitEvent() {},
    runtime: {
      dialog: {
        open: (name, params, signal) => { calls.push({ open: name, params, signal }); return open(signal); },
        close: (result) => { calls.push({ close: result }); return null; },
      },
    },
  };
}

test("runtime.dialog.open passes the name, the params and the signal of the call to the runtime and replies its result", async () => {
  const calls = [];
  const answer = await answerViewCall({ id: 1, command: "runtime.dialog.open", params: { name: "edit", params: { row: 3 } } }, optionsWith(calls));
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].open, calls[0].params], ["edit", { row: 3 }]);
  assert.ok(calls[0].signal instanceof AbortSignal, "the runtime receives the signal of the call");
  assert.deepEqual(answer, { saved: true });
});

test("runtime.dialog.open passes null when params is absent", async () => {
  const calls = [];
  await answerViewCall({ id: 2, command: "runtime.dialog.open", params: { name: "edit" } }, optionsWith(calls));
  assert.equal(calls[0].params, null);
});

test("a cancel of runtime.dialog.open aborts the signal that the runtime received", async () => {
  const calls = [];
  const options = optionsWith(calls, (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(null))));
  const open = answerViewCall({ id: 3, command: "runtime.dialog.open", params: { name: "edit" } }, options);
  await answerViewCall({ id: 3, cancel: true }, options);
  await assert.rejects(open, /^Error: cancelled$/);
  assert.equal(calls[0].signal.aborted, true);
});

test("runtime.dialog.open refuses a name that is not a non-empty text and another member, and runs nothing", async () => {
  const calls = [];
  for (const [params, message] of [
    [{ name: "" }, /view call runtime.dialog.open requires a non-empty name/],
    [{}, /view call runtime.dialog.open requires a non-empty name/],
    [{ name: "edit", title: "Edit" }, /view call runtime.dialog.open takes only name and params/],
    [null, /view call runtime.dialog.open/],
  ]) {
    await assert.rejects(answerViewCall({ id: 4, command: "runtime.dialog.open", params }, optionsWith(calls)), message);
  }
  assert.deepEqual(calls, []);
});

test("runtime.dialog.close passes the result to the runtime, null when it is absent, and replies null", async () => {
  const calls = [];
  assert.equal(await answerViewCall({ id: 5, command: "runtime.dialog.close", params: { result: { saved: true } } }, optionsWith(calls)), null);
  assert.equal(await answerViewCall({ id: 6, command: "runtime.dialog.close", params: {} }, optionsWith(calls)), null);
  assert.deepEqual(calls, [{ close: { saved: true } }, { close: null }]);
  await assert.rejects(answerViewCall({ id: 7, command: "runtime.dialog.close", params: { result: 1, extra: 2 } }, optionsWith(calls)),
    /view call runtime.dialog.close takes only result/);
});

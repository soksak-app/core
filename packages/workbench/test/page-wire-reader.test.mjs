// The reader of a page-wire case matches the calls of the host method log in their own order among the log steps, and every other call in
// its order among the other steps (docs/spec/cases/page-wire/README.md#reader-semantics).
import assert from "node:assert/strict";
import { test } from "node:test";
import { openPageWire } from "./runtime/page-wire.js";

const snapshot = { kind: "snapshot" };
const clock = { action: "clock" };
const settings = { kind: "settings", id: null, patch: { left: false }, remove: [] };

// Each row is the order of the calls of the page: a name and its payload.
const orders = {
  "the case order": [["workspace", snapshot], ["log", clock], ["workspace", settings]],
  "the log call first": [["log", clock], ["workspace", snapshot], ["workspace", settings]],
  "the log call last": [["workspace", snapshot], ["workspace", settings], ["log", clock]],
};

for (const [name, calls] of Object.entries(orders)) {
  test(`the reader answers every call of the case in ${name}`, async () => {
    const wire = openPageWire("page-wire-reader-log-order");
    const answers = [];
    for (const [call, payload] of calls) answers.push(await wire.call(call, payload));
    assert.deepEqual(answers.find((answer) => answer?.ts_us !== undefined), { ts_us: 1791000000000456, mono_ns: 5000000789 });
    wire.finish();
  });
}

test("a call of the other stream that deviates from its step fails", async () => {
  const wire = openPageWire("page-wire-reader-log-order");
  await assert.rejects(wire.call("workspace", settings), /step 0: call\.payload\.kind/);
  assert.throws(() => wire.finish(), /page-wire-reader-log-order: step 0/);
});

test("a log call that deviates from the log step fails", async () => {
  const wire = openPageWire("page-wire-reader-log-order");
  await assert.rejects(wire.call("log", { action: "policy-read" }), /step 2: call\.payload\.action/);
  assert.throws(() => wire.finish(), /step 2/);
});

test("a log call after the last log step fails", async () => {
  const wire = openPageWire("page-wire-reader-log-order");
  await wire.call("log", clock);
  await assert.rejects(wire.call("log", clock), /after the last log step of the case/);
});

test("finish names the log step that the page did not play", async () => {
  const wire = openPageWire("page-wire-reader-log-order");
  await wire.call("workspace", snapshot);
  await wire.call("workspace", settings);
  assert.throws(() => wire.finish(), /1 log steps of the case were not played, starting with .*"clock"/);
});

// The replies of the case are held; each settles in the order of the settled list.
function holdAll(wire) {
  const settled = [];
  const pending = [
    ["snapshot", wire.call("workspace", snapshot)],
    ["clock", wire.call("log", clock)],
    ["settings", wire.call("workspace", settings)],
  ].map(([label, reply]) => reply.then(() => settled.push(label)));
  return { settled, pending };
}

test("release settles the held reply of the step that its key names, in any order", async () => {
  const wire = openPageWire("page-wire-reader-held-order");
  const { settled, pending } = holdAll(wire);
  wire.release(4);
  wire.release("log");
  wire.release();
  await Promise.all(pending);
  assert.deepEqual(settled, ["settings", "clock", "snapshot"]);
  wire.finish();
});

test("release without a key settles the oldest held reply, and a name settles the oldest reply of that call", async () => {
  const wire = openPageWire("page-wire-reader-held-order");
  const { settled, pending } = holdAll(wire);
  wire.release("workspace");
  wire.release("workspace");
  wire.release();
  await Promise.all(pending);
  assert.deepEqual(settled, ["snapshot", "settings", "clock"]);
  wire.finish();
});

test("release of a key that no held reply has fails and is kept as a failure", async () => {
  const wire = openPageWire("page-wire-reader-held-order");
  const { pending } = holdAll(wire);
  assert.throws(() => wire.release(1), /page-wire-reader-held-order: release found no held reply of step 1/);
  assert.throws(() => wire.release("pluginsRun"), /release found no held reply of "pluginsRun"/);
  wire.release();
  wire.release();
  wire.release();
  await Promise.all(pending);
  assert.throws(() => wire.release(), /release found no held reply$/m);
  assert.throws(() => wire.finish(), /release found no held reply of step 1/);
});

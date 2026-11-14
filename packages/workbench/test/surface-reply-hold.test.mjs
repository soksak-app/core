import assert from "node:assert/strict";
import test from "node:test";
import { host, selectPageWire } from "@soksak/runtime";
import { recordsOf, shownRecord } from "./support/records.mjs";

// The held replies are the host call exposureReply, and the observation line of an ended hold is the record that the page sends to the
// host call log. The host answers each call with the reply of the page-wire case of the test (docs/spec/cases/page-wire/README.md). The case
// of the first test is selected before page-log.js is imported, because the page reads the host when its modules are imported.
const first = selectPageWire("surface-reply-hold-closed");
const { createSurfaceReplyHold } = await import("../surface-reply-hold.js");
const { log } = await import("../host.js");
const { flushEvents } = await import("../page-log.js");
const { logGate } = await import("../log-gate.js");
// The observation line is an info record, which the gate stores at this level.
logGate.set({ lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" });

/** The reply of the surface with the id, as the page sends it to the host. */
const send = (surface, id) => () => host.call("exposureReply", { id, result: null, surface });
/** The ids of the replies that the page sent to the host so far. */
const sentIds = (wire) => wire.calls.filter(({ name }) => name === "exposureReply").map(({ payload }) => payload.id);
/** The lines `<level> workbench <where>: <text>` of the records that the page sent to the host so far. */
const linesOf = (wire) => wire.calls.flatMap((call) => recordsOf(call.name, call.payload)).map(shownRecord);

test("a held surface reply is sent only after the host reports the surface closed", async () => {
  const wire = first;
  const hold = createSurfaceReplyHold(log);
  hold.hold("tab-a");
  let answered = false;
  const result = hold.gate("tab-a", send("tab-a", 7)).then((value) => { answered = value; });
  await hold.held("tab-a");
  assert.deepEqual(sentIds(wire), [], "the reply was sent while the surface was open");
  const closed = hold.closed("tab-a");
  assert.deepEqual(sentIds(wire), [7]);
  await flushEvents();
  assert.deepEqual(linesOf(wire), [], "the line was written before the host answered the reply");
  wire.release();
  await closed;
  await result;
  assert.equal(answered, null, "the caller did not receive the answer of the late reply");
  await flushEvents();
  assert.deepEqual(linesOf(wire), ['info workbench workbench: held exposure replies of surface "tab-a" were sent after the surface closed (1)']);
  wire.finish();
});

test("a held reply that the host refuses rejects to its caller and still writes the line", async () => {
  const wire = selectPageWire("surface-reply-hold-refused");
  const hold = createSurfaceReplyHold(log);
  hold.hold("tab-a");
  const result = hold.gate("tab-a", send("tab-a", 8));
  const closed = hold.closed("tab-a");
  wire.release();
  await assert.rejects(result, /window is not available/);
  await closed;
  await flushEvents();
  assert.deepEqual(linesOf(wire), ['info workbench workbench: held exposure replies of surface "tab-a" were sent after the surface closed (1)']);
  wire.finish();
});

test("a reply of another surface, or after the hold ended, is sent at once", async () => {
  const wire = selectPageWire("surface-reply-hold-at-once");
  const hold = createSurfaceReplyHold(log);
  hold.hold("tab-a");
  await hold.gate("tab-b", send("tab-b", 1));
  await hold.closed("tab-a");
  await hold.gate("tab-a", send("tab-a", 2));
  assert.deepEqual(wire.calls.filter(({ name }) => name === "exposureReply").map(({ payload }) => payload.surface), ["tab-b", "tab-a"]);
  assert.equal(await hold.closed("tab-a"), undefined, "a close of a surface without a hold did something");
  await flushEvents();
  wire.finish();
});

test("held waits for a held reply and fails without a hold or when the surface closes first", async () => {
  const wire = selectPageWire("surface-reply-hold-held");
  const hold = createSurfaceReplyHold(log);
  assert.throws(() => hold.held("tab-a"), /^Error: exposure replies of surface "tab-a" are not held$/);
  hold.hold("tab-a");
  // The gate call runs in a microtask queued after the then of held. A held that resolved before any reply was held answers first.
  const order = [];
  const waiting = hold.held("tab-a").then(() => { order.push("held"); });
  let reply;
  queueMicrotask(() => {
    order.push("gate");
    reply = hold.gate("tab-a", send("tab-a", 3));
  });
  await waiting;
  assert.deepEqual(order, ["gate", "held"], "held answered before a reply was held");
  await hold.closed("tab-a");
  assert.equal(await reply, null);
  hold.hold("tab-b");
  const early = hold.held("tab-b");
  await hold.closed("tab-b");
  await assert.rejects(early, /^Error: surface "tab-b" closed before it held an exposure reply$/);
  await flushEvents();
  wire.finish();
});

test("hold rejects an invalid surface and a second hold of the same surface", () => {
  const wire = selectPageWire("surface-reply-hold-invalid");
  const hold = createSurfaceReplyHold(log);
  for (const surface of [undefined, null, "", 3]) {
    assert.throws(() => hold.hold(surface), /^Error: diagnostics.surface.hold requires surface$/);
  }
  assert.throws(() => hold.held(""), /^Error: diagnostics.surface.held requires surface$/);
  hold.hold("tab-a");
  assert.throws(() => hold.hold("tab-a"), /^Error: exposure replies of surface "tab-a" are already held$/);
  wire.finish();
});

test("a released surface sends its held replies in order and writes the line of the ended hold", async () => {
  const wire = selectPageWire("surface-reply-hold-released");
  const hold = createSurfaceReplyHold(log);
  hold.hold("tab-a");
  const answers = [hold.gate("tab-a", send("tab-a", 1)), hold.gate("tab-a", send("tab-a", 2))];
  assert.deepEqual(sentIds(wire), [], "a reply was sent while the surface was held");
  const released = hold.released("tab-a");
  assert.deepEqual(sentIds(wire), [1, 2], "the release did not send the held replies in the order held");
  wire.release();
  await answers[0];
  await flushEvents();
  assert.deepEqual(linesOf(wire), [], "the line was written before the host answered every reply");
  wire.release();
  await released;
  assert.deepEqual(await Promise.all(answers), [null, null]);
  await flushEvents();
  assert.deepEqual(linesOf(wire), ['info workbench workbench: held exposure replies of surface "tab-a" were sent after their hold ended (2)']);
  await hold.gate("tab-a", send("tab-a", 3));
  assert.deepEqual(sentIds(wire), [1, 2, 3], "a reply after the release was held");
  hold.hold("tab-a");
  wire.finish();
});

test("a release fails a waiting held and leaves a surface without a hold alone", async () => {
  const wire = selectPageWire("surface-reply-hold-released-waiting");
  const hold = createSurfaceReplyHold(log);
  assert.equal(await hold.released("tab-a"), undefined, "a release of a surface without a hold did something");
  hold.hold("tab-a");
  const waiting = hold.held("tab-a");
  await hold.released("tab-a");
  await assert.rejects(waiting, /^Error: the hold of surface "tab-a" ended before it held an exposure reply$/);
  await flushEvents();
  assert.deepEqual(linesOf(wire), ['info workbench workbench: held exposure replies of surface "tab-a" were sent after their hold ended (0)']);
  wire.finish();
});

test("the end of the page ends every hold before the reload", async () => {
  const wire = selectPageWire("surface-reply-hold-end-all");
  const hold = createSurfaceReplyHold(log);
  hold.hold("tab-a");
  hold.hold("tab-b");
  const replies = [
    hold.gate("tab-a", send("tab-a", 1)),
    hold.gate("tab-b", send("tab-b", 2)),
  ];
  await hold.endAll();
  await Promise.all(replies);
  assert.deepEqual(sentIds(wire), [1, 2]);
  await flushEvents();
  assert.deepEqual(linesOf(wire).sort(), [
    'info workbench workbench: held exposure replies of surface "tab-a" were sent after their hold ended (1)',
    'info workbench workbench: held exposure replies of surface "tab-b" were sent after their hold ended (1)',
  ]);
  await hold.gate("tab-a", send("tab-a", 3));
  assert.deepEqual(sentIds(wire), [1, 2, 3], "a hold remained after the end of the page");
  wire.finish();
});

// Checks the declared UI snapshots over fake transports. Nothing in the module uses a timer, so no test mocks a clock.
import assert from "node:assert/strict";
import test from "node:test";
import { createSnapshotReceiver, createSnapshotSender, pullSnapshots } from "../snapshots.js";

function fakeTransport() {
  const sent = [];
  const listeners = new Set();
  return {
    sent,
    send(message) { sent.push(message); },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    deliver(message) {
      for (const listener of listeners) listener(message);
    },
  };
}

function setup(overrides = {}) {
  const transport = fakeTransport();
  const reports = [];
  const sender = createSnapshotSender({
    plugin: "probe",
    send: transport.send,
    onMessage: transport.onMessage,
    report: (event) => reports.push(event),
    ...overrides,
  });
  const snapshots = () => transport.sent.filter((message) => message.event === "declared-ui.snapshot");
  const ack = (status, seq) => transport.deliver({ event: "declared-ui.snapshot.ack", plugin: "probe", status, seq });
  const ofKind = (kind) => reports.filter((event) => event.kind === kind);
  return { sender, transport, reports, snapshots, ack, ofKind };
}

test("createSnapshotSender requires a plugin id, the transport functions and a report function", () => {
  const transport = fakeTransport();
  const valid = { plugin: "probe", send: transport.send, onMessage: transport.onMessage, report: () => {} };
  assert.throws(() => createSnapshotSender({ ...valid, plugin: "" }), TypeError);
  assert.throws(() => createSnapshotSender({ ...valid, send: undefined }), TypeError);
  assert.throws(() => createSnapshotSender({ ...valid, onMessage: undefined }), TypeError);
  assert.throws(() => createSnapshotSender({ ...valid, report: undefined }), TypeError);
});

test("createSnapshotReceiver requires a plugin id, the transport functions and an onSnapshot function", () => {
  const transport = fakeTransport();
  const valid = { plugin: "probe", send: transport.send, onMessage: transport.onMessage, onSnapshot: () => {} };
  assert.throws(() => createSnapshotReceiver({ ...valid, plugin: "" }), TypeError);
  assert.throws(() => createSnapshotReceiver({ ...valid, send: undefined }), TypeError);
  assert.throws(() => createSnapshotReceiver({ ...valid, onMessage: undefined }), TypeError);
  assert.throws(() => createSnapshotReceiver({ ...valid, onSnapshot: undefined }), TypeError);
});

test("push sends the snapshot event with the plugin, the status, the seq and the value", () => {
  const { sender, snapshots } = setup();
  sender.push("probe.tree", { rows: 1 });
  assert.deepEqual(snapshots(), [
    { event: "declared-ui.snapshot", plugin: "probe", status: "probe.tree", seq: 1, value: { rows: 1 } },
  ]);
});

test("a status has at most one snapshot in transit, and a push during the flight waits for the acknowledgement", () => {
  const { sender, snapshots, ack, ofKind } = setup();
  sender.push("probe.tree", "a");
  sender.push("probe.tree", "b");
  assert.equal(snapshots().length, 1, "the second push is not sent while the first is in transit");
  assert.equal(ofKind("skipped").length, 0, "one dirty value is not yet skipped");
  ack("probe.tree", 1);
  assert.equal(snapshots().length, 2);
  assert.deepEqual(snapshots()[1], { event: "declared-ui.snapshot", plugin: "probe", status: "probe.tree", seq: 2, value: "b" });
});

test("an acknowledgement with no dirty mark releases the slot without a new snapshot", () => {
  const { sender, snapshots, ack } = setup();
  sender.push("probe.tree", "a");
  ack("probe.tree", 1);
  assert.equal(snapshots().length, 1);
  sender.push("probe.tree", "b");
  assert.equal(snapshots().length, 2, "a push after the acknowledgement is sent at once");
});

test("values skipped while a snapshot is in transit are counted, and the latest value is sent", () => {
  const { sender, snapshots, ack, ofKind } = setup();
  sender.push("probe.tree", "v1");
  sender.push("probe.tree", "v2");
  sender.push("probe.tree", "v3");
  sender.push("probe.tree", "v4");
  assert.equal(ofKind("skipped").length, 2, "v2 and v3 are overwritten before the acknowledgement");
  for (const event of ofKind("skipped")) {
    assert.deepEqual(event, { kind: "skipped", plugin: "probe", status: "probe.tree", count: 1 });
  }
  ack("probe.tree", 1);
  assert.equal(snapshots().length, 2);
  assert.equal(snapshots()[1].value, "v4");
  assert.equal(snapshots()[1].seq, 4, "the seq of a snapshot is the seq of the value it carries");
  ack("probe.tree", 4);
  assert.equal(snapshots().length, 2, "no snapshot follows when no value is dirty");
});

test("the statuses of one plugin hold their slots independently", () => {
  const { sender, snapshots, ack } = setup();
  sender.push("probe.tree", "t1");
  sender.push("probe.badge", "b1");
  assert.equal(snapshots().length, 2, "a status in transit does not hold another status");
  sender.push("probe.tree", "t2");
  ack("probe.badge", 1);
  assert.equal(snapshots().length, 2, "an acknowledgement of one status does not send another status");
  ack("probe.tree", 1);
  assert.equal(snapshots().length, 3);
  assert.equal(snapshots()[2].status, "probe.tree");
  assert.equal(snapshots()[2].value, "t2");
});

test("an acknowledgement with no snapshot in transit or another seq is refused", () => {
  const { sender, ack } = setup();
  assert.throws(() => ack("probe.tree", 1), /declared UI snapshot ack probe\.tree 1 has no snapshot in transit/);
  sender.push("probe.tree", "a");
  assert.throws(() => ack("probe.tree", 2), /has no snapshot in transit/);
  ack("probe.tree", 1);
  assert.throws(() => ack("probe.tree", 1), /has no snapshot in transit/);
});

test("an acknowledgement of another plugin or with an invalid field is refused", () => {
  const { sender, transport } = setup();
  sender.push("probe.tree", "a");
  assert.throws(() => transport.deliver({ event: "declared-ui.snapshot.ack", plugin: "other", status: "probe.tree", seq: 1 }), TypeError);
  assert.throws(() => transport.deliver({ event: "declared-ui.snapshot.ack", plugin: "probe", status: "probe.tree", seq: "1" }), TypeError);
  assert.throws(() => transport.deliver({ event: "declared-ui.snapshot.ack", plugin: "probe", status: "", seq: 1 }), TypeError);
  assert.throws(() => transport.deliver({ plugin: "probe", status: "probe.tree", seq: 1 }), TypeError);
});

test("push refuses an invalid status or an undefined value", () => {
  const { sender, snapshots } = setup();
  assert.throws(() => sender.push("", "a"), TypeError);
  assert.throws(() => sender.push(7, "a"), TypeError);
  assert.throws(() => sender.push("probe.tree", undefined), TypeError);
  assert.equal(snapshots().length, 0);
});

test("a send that throws clears the slot, reaches the caller, and the next push sends again", () => {
  let fail = true;
  const transport = fakeTransport();
  const sender = createSnapshotSender({
    plugin: "probe",
    send(message) {
      if (fail) throw new Error("transport closed");
      transport.send(message);
    },
    onMessage: transport.onMessage,
    report: () => {},
  });
  assert.throws(() => sender.push("probe.tree", "a"), /transport closed/);
  fail = false;
  sender.push("probe.tree", "b");
  assert.equal(transport.sent.length, 1);
  assert.deepEqual(transport.sent[0], { event: "declared-ui.snapshot", plugin: "probe", status: "probe.tree", seq: 2, value: "b" });
});

test("peerLost with process-ended stalls the pending acknowledgement, and the next push of a new process is sent at once", () => {
  const { sender, snapshots, ofKind } = setup();
  sender.push("probe.tree", "old");
  sender.push("probe.tree", "dirty");
  sender.peerLost("process-ended");
  assert.deepEqual(ofKind("stalled"), [{ kind: "stalled", plugin: "probe", status: "probe.tree", reason: "process-ended", count: 1 }]);
  assert.equal(ofKind("skipped").length, 0);
  sender.push("probe.tree", "full");
  assert.equal(snapshots().length, 2, "the restarted process does not wait for the acknowledgement of the stopped one");
  assert.deepEqual(snapshots()[1], { event: "declared-ui.snapshot", plugin: "probe", status: "probe.tree", seq: 3, value: "full" });
});

test("peerLost with surface-closed discards a dirty value and counts it as a stall as well", () => {
  const { sender, snapshots, ack, ofKind } = setup();
  sender.push("probe.tree", "sent");
  sender.push("probe.tree", "dirty");
  sender.peerLost("surface-closed");
  assert.deepEqual(ofKind("stalled"), [
    { kind: "stalled", plugin: "probe", status: "probe.tree", reason: "surface-closed", count: 1 },
    { kind: "stalled", plugin: "probe", status: "probe.tree", reason: "surface-closed", count: 1 },
  ]);
  assert.equal(snapshots().length, 1, "the dirty value is not sent");
  assert.throws(() => ack("probe.tree", 1), /has no snapshot in transit/);
});

test("peerLost reports one stall for each status whose acknowledgement is pending, and none for a status that is idle", () => {
  const { sender, ack, ofKind } = setup();
  sender.push("probe.tree", "a");
  sender.push("probe.badge", "b");
  sender.push("probe.idle", "c");
  ack("probe.idle", 1);
  sender.peerLost("process-ended");
  assert.deepEqual(ofKind("stalled").map((event) => event.status), ["probe.tree", "probe.badge"]);
  sender.peerLost("process-ended");
  assert.equal(ofKind("stalled").length, 2, "a second peer loss with nothing pending reports nothing");
});

test("peerLost refuses a reason that is not a peer-lost reason", () => {
  const { sender } = setup();
  assert.throws(() => sender.peerLost("timeout"), RangeError);
});

test("close stops the acknowledgements, so a later acknowledgement is not received", () => {
  const { sender, transport, snapshots, ack } = setup();
  sender.push("probe.tree", "a");
  sender.push("probe.tree", "b");
  sender.close();
  assert.doesNotThrow(() => ack("probe.tree", 1));
  assert.equal(snapshots().length, 1, "the dirty value is not sent after close");
  assert.equal(transport.sent.length, 1);
});

test("pull returns the latest value and its seq of a status, and refuses a status with no value", () => {
  const { sender, ack } = setup();
  assert.throws(() => sender.pull("probe.tree"), /probe\.tree has no value/);
  sender.push("probe.tree", "a");
  sender.push("probe.tree", "b");
  assert.deepEqual(sender.pull("probe.tree"), { seq: 2, value: "b" });
  ack("probe.tree", 1);
  assert.deepEqual(sender.pull("probe.tree"), { seq: 2, value: "b" });
});

test("the receiver acknowledges each snapshot with its seq and passes the value to onSnapshot", () => {
  const transport = fakeTransport();
  const received = [];
  createSnapshotReceiver({
    plugin: "probe",
    send: transport.send,
    onMessage: transport.onMessage,
    onSnapshot: (status, seq, value) => received.push({ status, seq, value }),
  });
  transport.deliver({ event: "declared-ui.snapshot", plugin: "probe", status: "probe.tree", seq: 3, value: "x" });
  assert.deepEqual(received, [{ status: "probe.tree", seq: 3, value: "x" }]);
  assert.deepEqual(transport.sent, [{ event: "declared-ui.snapshot.ack", plugin: "probe", status: "probe.tree", seq: 3 }]);
});

test("the receiver refuses a snapshot of another plugin or with an invalid field", () => {
  const transport = fakeTransport();
  createSnapshotReceiver({ plugin: "probe", send: transport.send, onMessage: transport.onMessage, onSnapshot: () => {} });
  assert.throws(() => transport.deliver({ event: "declared-ui.snapshot", plugin: "other", status: "s", seq: 1, value: 1 }), TypeError);
  assert.throws(() => transport.deliver({ event: "declared-ui.snapshot", plugin: "probe", status: "s", seq: 0, value: 1 }), TypeError);
  assert.throws(() => transport.deliver({ event: "declared-ui.snapshot", plugin: "probe", status: "s", seq: 1 }), TypeError);
  assert.deepEqual(transport.sent, []);
});

test("pullSnapshots requests each status once and passes each reply to onSnapshot", async () => {
  const requests = [];
  const received = [];
  const request = async (command, params) => {
    requests.push({ command, params });
    return { seq: 2, value: `value of ${params.status}` };
  };
  await pullSnapshots({
    statuses: ["probe.tree", "probe.badge"],
    request,
    onSnapshot: (status, seq, value) => received.push({ status, seq, value }),
  });
  assert.deepEqual(requests, [
    { command: "declared-ui.snapshot.request", params: { status: "probe.tree" } },
    { command: "declared-ui.snapshot.request", params: { status: "probe.badge" } },
  ]);
  assert.deepEqual(received, [
    { status: "probe.tree", seq: 2, value: "value of probe.tree" },
    { status: "probe.badge", seq: 2, value: "value of probe.badge" },
  ]);
});

test("pullSnapshots with no status sends no request", async () => {
  let calls = 0;
  await pullSnapshots({ statuses: [], request: async () => { calls += 1; }, onSnapshot: () => {} });
  assert.equal(calls, 0);
});

test("pullSnapshots refuses duplicate or invalid statuses before it sends a request", async () => {
  let calls = 0;
  const request = async () => { calls += 1; return { seq: 1, value: 1 }; };
  await assert.rejects(pullSnapshots({ statuses: ["a", "a"], request, onSnapshot: () => {} }), TypeError);
  await assert.rejects(pullSnapshots({ statuses: [""], request, onSnapshot: () => {} }), TypeError);
  await assert.rejects(pullSnapshots({ statuses: "a", request, onSnapshot: () => {} }), TypeError);
  assert.equal(calls, 0);
});

test("pullSnapshots refuses a reply without an integer seq and rejects with every failed status", async () => {
  const received = [];
  const request = async (command, params) => {
    if (params.status === "probe.bad") return { value: 1 };
    if (params.status === "probe.lost") throw new Error("peer lost");
    return { seq: 1, value: "ok" };
  };
  await assert.rejects(
    pullSnapshots({
      statuses: ["probe.bad", "probe.lost", "probe.ok"],
      request,
      onSnapshot: (status) => received.push(status),
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].message, /reply.*seq/);
      assert.equal(error.errors[1].message, "peer lost");
      return true;
    },
  );
  assert.deepEqual(received, ["probe.ok"], "the other statuses are still applied");
});

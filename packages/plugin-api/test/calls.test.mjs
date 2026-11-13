// Checks the plugin call layer over a transport that the test passes in. A call has no time limit: its reply, its cancel or the end
// of its peer ends it (docs/spec/plugin-processes.md, rule 3). The instants of the layer come from its now parameter, which the test
// sets: the start of a call and the arrival of a late reply are data of the test.
import assert from "node:assert/strict";
import test from "node:test";
import * as callsModule from "../calls.js";
import * as pluginApi from "../index.js";
import { createCalls } from "../calls.js";

function transportOf() {
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

// The instant of the layer is clock.at, in milliseconds; the test moves it forward and each call reads it when the call starts.
function setup(overrides = {}) {
  const transport = transportOf();
  const reports = [];
  const clock = { at: 0 };
  const calls = createCalls({
    plugin: "probe",
    send: transport.send,
    onMessage: transport.onMessage,
    report: (event) => reports.push(event),
    now: () => clock.at,
    ...overrides,
  });
  const ofKind = (kind) => reports.filter((event) => event.kind === kind);
  return { calls, transport, reports, ofKind, clock };
}

test("createCalls requires a plugin id, the transport functions and a report function", () => {
  const transport = transportOf();
  const valid = { plugin: "probe", send: transport.send, onMessage: transport.onMessage, report: () => {} };
  assert.throws(() => createCalls({ ...valid, plugin: "" }), TypeError);
  assert.throws(() => createCalls({ ...valid, send: undefined }), TypeError);
  assert.throws(() => createCalls({ ...valid, onMessage: undefined }), TypeError);
  assert.throws(() => createCalls({ ...valid, report: undefined }), TypeError);
});

test("a request sends its id, command and params, and each reply resolves the call with the same id", async () => {
  const { calls, transport } = setup();
  const first = calls.request("probe.run", { a: 1 });
  const second = calls.request("probe.read", null);
  assert.deepEqual(transport.sent, [
    { id: 1, command: "probe.run", params: { a: 1 } },
    { id: 2, command: "probe.read", params: null },
  ]);
  transport.deliver({ id: 2, result: "second" });
  transport.deliver({ id: 1, result: "first" });
  assert.equal(await first, "first");
  assert.equal(await second, "second");
});

test("a reply with an error rejects the call with its code and message", async () => {
  const { calls, transport } = setup();
  const failed = calls.request("probe.run");
  transport.deliver({ id: 1, error: { code: -32602, message: "bad" } });
  await assert.rejects(failed, { code: -32602, message: "bad" });
});

test("a reply whose error has no message throws an explicit error and keeps the call open", async () => {
  const { calls, transport } = setup();
  const pending = calls.request("probe.run");
  assert.throws(() => transport.deliver({ id: 1, error: { code: -32602 } }), /call reply 1 has an error without a message/);
  assert.equal(calls.openCalls().count, 1);
  transport.deliver({ id: 1, result: 2 });
  assert.equal(await pending, 2);
});

test("a message that is not a reply, or a reply to no request, throws an explicit error", () => {
  const { transport } = setup();
  assert.throws(() => transport.deliver({ result: 1 }), /is not a reply with an integer id/);
  assert.throws(() => transport.deliver({ id: 7, result: 1 }), /call reply 7 has no matching request/);
});

test("cancellation sends a cancel message and rejects the call with reason cancelled", async () => {
  const { calls, transport, ofKind } = setup();
  const controller = new AbortController();
  const cancelled = calls.request("probe.run", {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { reason: "cancelled" });
  assert.deepEqual(transport.sent[1], { id: 1, cancel: true });
  assert.deepEqual(calls.openCalls(), { count: 0, oldestStartedAt: null });
  assert.deepEqual(ofKind("late-reply"), []);
});

test("a call whose signal is already aborted is rejected without sending anything", async () => {
  const { calls, transport } = setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(calls.request("probe.run", {}, { signal: controller.signal }), { reason: "cancelled" });
  assert.deepEqual(transport.sent, []);
});

test("a reply that arrives after the cancellation is discarded and counted as a late reply", async () => {
  const { calls, transport, ofKind, clock } = setup();
  const controller = new AbortController();
  const cancelled = calls.request("probe.run", {}, { signal: controller.signal });
  clock.at += 5;
  controller.abort();
  await assert.rejects(cancelled, { reason: "cancelled" });
  clock.at += 20;
  transport.deliver({ id: 1, result: "late" });
  assert.deepEqual(ofKind("late-reply"), [{ kind: "late-reply", plugin: "probe", command: "probe.run", delay: 25 }]);
});

// contract: exposure.command.ends-by-reply-or-peer-end
// The call layer has no timer: the contract refuses a time limit of a call (docs/spec/plugin-processes.md, rule 3), so an open call
// waits for its reply, its cancel or the end of its peer, and no deadline is armed.
test("a call starts no timer, stays open until its reply, and its reply ends it", async () => {
  const { calls, transport, reports } = setup();
  const done = calls.request("probe.run");
  assert.deepEqual(calls.openCalls(), { count: 1, oldestStartedAt: 0 });
  transport.deliver({ id: 1, result: "ok" });
  assert.equal(await done, "ok");
  assert.deepEqual(calls.openCalls(), { count: 0, oldestStartedAt: null });
  assert.deepEqual(reports.map((event) => event.kind), ["open-calls", "open-calls"]);
});

test("a request refuses a timeout option before anything is sent", () => {
  const { calls, transport } = setup();
  for (const timeout of [1000, 600000, 0]) {
    assert.throws(() => calls.request("probe.run", {}, { timeout }),
      (error) => (error instanceof TypeError || error instanceof RangeError) && /\btimeout\b/.test(error.message),
      `a request accepted the timeout ${timeout}`);
  }
  assert.deepEqual(transport.sent, []);
  assert.deepEqual(calls.openCalls(), { count: 0, oldestStartedAt: null });
});

test("the call layer exports no time limit of a call", () => {
  for (const name of ["DEFAULT_CALL_TIMEOUT", "MAX_CALL_TIMEOUT"]) {
    assert.equal(name in callsModule, false, `calls.js exports ${name}`);
    assert.equal(name in pluginApi, false, `@soksak/plugin-api exports ${name}`);
  }
});

test("peer lost rejects every open call with the reason and reports each call", async () => {
  const { calls, ofKind } = setup();
  const first = calls.request("probe.a");
  const second = calls.request("probe.b");
  const rejectedFirst = assert.rejects(first, { reason: "process-ended", message: "command probe.a ended: process-ended" });
  const rejectedSecond = assert.rejects(second, { reason: "process-ended", message: "command probe.b ended: process-ended" });
  calls.peerLost("process-ended");
  await rejectedFirst;
  await rejectedSecond;
  assert.deepEqual(ofKind("peer-lost"), [
    { kind: "peer-lost", plugin: "probe", command: "probe.a", reason: "process-ended" },
    { kind: "peer-lost", plugin: "probe", command: "probe.b", reason: "process-ended" },
  ]);
  assert.deepEqual(calls.openCalls(), { count: 0, oldestStartedAt: null });
});

test("surface-closed and sidecar-ended end calls with their own reasons", async () => {
  const { calls, ofKind } = setup();
  const closed = calls.request("probe.a");
  const rejectedClosed = assert.rejects(closed, { reason: "surface-closed" });
  calls.peerLost("surface-closed");
  await rejectedClosed;
  const ended = calls.request("probe.b");
  const rejectedEnded = assert.rejects(ended, { reason: "sidecar-ended" });
  calls.peerLost("sidecar-ended");
  await rejectedEnded;
  assert.deepEqual(ofKind("peer-lost").map((event) => event.reason), ["surface-closed", "sidecar-ended"]);
});

test("a peer-lost reason outside the declared reasons is rejected", () => {
  const { calls } = setup();
  assert.throws(() => calls.peerLost("unresponsive"), /peer lost reason must be one of process-ended, surface-closed, sidecar-ended/);
});

test("openCalls gives the count and the start time of the oldest open call, and each change is reported", async () => {
  const { calls, transport, ofKind, clock } = setup();
  const started = clock.at;
  const first = calls.request("probe.a");
  clock.at += 5;
  const second = calls.request("probe.b");
  assert.deepEqual(calls.openCalls(), { count: 2, oldestStartedAt: started });
  transport.deliver({ id: 1, result: null });
  await first;
  assert.deepEqual(calls.openCalls(), { count: 1, oldestStartedAt: started + 5 });
  transport.deliver({ id: 2, result: null });
  await second;
  assert.deepEqual(calls.openCalls(), { count: 0, oldestStartedAt: null });
  assert.deepEqual(ofKind("open-calls").map((event) => event.count), [1, 2, 1, 0]);
  assert.deepEqual(ofKind("open-calls").at(-1), { kind: "open-calls", plugin: "probe", count: 0, oldestStartedAt: null });
});

test("a send that throws rejects the call with that error and leaves no open call", async () => {
  const { calls, ofKind } = setup({ send: () => { throw new Error("transport closed"); } });
  await assert.rejects(calls.request("probe.run"), /transport closed/);
  assert.deepEqual(calls.openCalls(), { count: 0, oldestStartedAt: null });
  assert.deepEqual(ofKind("open-calls").map((event) => event.count), [0]);
});

test("the last 256 ended calls are remembered, and a reply to an older ended call is refused", async () => {
  const { calls, transport, ofKind } = setup();
  const ended = [];
  for (let index = 0; index < 257; index += 1) {
    const controller = new AbortController();
    ended.push(calls.request("probe.run", {}, { signal: controller.signal }).catch(() => {}));
    controller.abort();
  }
  await Promise.all(ended);
  transport.deliver({ id: 257, result: 1 });
  assert.equal(ofKind("late-reply").length, 1);
  assert.throws(() => transport.deliver({ id: 1, result: 1 }), /call reply 1 has no matching request/);
});

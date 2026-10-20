// Checks the plugin call layer over a fake transport. The timers and the clock are mocked, so no test waits.
import assert from "node:assert/strict";
import test from "node:test";
import { createCalls } from "../calls.js";

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

function setup(t, overrides = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const transport = fakeTransport();
  const reports = [];
  const calls = createCalls({
    plugin: "probe",
    send: transport.send,
    onMessage: transport.onMessage,
    report: (event) => reports.push(event),
    ...overrides,
  });
  const ofKind = (kind) => reports.filter((event) => event.kind === kind);
  return { calls, transport, reports, ofKind, timers: t.mock.timers };
}

test("createCalls requires a plugin id, the transport functions and a report function", () => {
  const transport = fakeTransport();
  const valid = { plugin: "probe", send: transport.send, onMessage: transport.onMessage, report: () => {} };
  assert.throws(() => createCalls({ ...valid, plugin: "" }), TypeError);
  assert.throws(() => createCalls({ ...valid, send: undefined }), TypeError);
  assert.throws(() => createCalls({ ...valid, onMessage: undefined }), TypeError);
  assert.throws(() => createCalls({ ...valid, report: undefined }), TypeError);
});

test("a request sends its id, command and params, and each reply resolves the call with the same id", async (t) => {
  const { calls, transport } = setup(t);
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

test("a reply with an error rejects the call with its code and message", async (t) => {
  const { calls, transport } = setup(t);
  const failed = calls.request("probe.run");
  transport.deliver({ id: 1, error: { code: -32602, message: "bad" } });
  await assert.rejects(failed, { code: -32602, message: "bad" });
});

test("a message that is not a reply, or a reply to no request, throws an explicit error", (t) => {
  const { transport } = setup(t);
  assert.throws(() => transport.deliver({ result: 1 }), /is not a reply with an integer id/);
  assert.throws(() => transport.deliver({ id: 7, result: 1 }), /call reply 7 has no matching request/);
});

test("cancellation sends a cancel message and rejects the call with reason cancelled", async (t) => {
  const { calls, transport, ofKind } = setup(t);
  const controller = new AbortController();
  const cancelled = calls.request("probe.run", {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { reason: "cancelled" });
  assert.deepEqual(transport.sent[1], { id: 1, cancel: true });
  assert.deepEqual(calls.openCalls(), { count: 0, oldestStartedAt: null });
  assert.deepEqual(ofKind("late-reply"), []);
});

test("a call whose signal is already aborted is rejected without sending anything", async (t) => {
  const { calls, transport } = setup(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(calls.request("probe.run", {}, { signal: controller.signal }), { reason: "cancelled" });
  assert.deepEqual(transport.sent, []);
});

test("a reply that arrives after the cancellation is discarded and counted as a late reply", async (t) => {
  const { calls, transport, ofKind, timers } = setup(t);
  const controller = new AbortController();
  const cancelled = calls.request("probe.run", {}, { signal: controller.signal });
  timers.tick(5);
  controller.abort();
  await assert.rejects(cancelled, { reason: "cancelled" });
  timers.tick(20);
  transport.deliver({ id: 1, result: "late" });
  assert.deepEqual(ofKind("late-reply"), [{ kind: "late-reply", plugin: "probe", command: "probe.run", delay: 25 }]);
});

test("a call without a declared timeout is rejected with -32000 after 10000 ms", async (t) => {
  const { calls, ofKind, timers } = setup(t);
  const failed = calls.request("probe.run");
  const rejected = assert.rejects(failed, { code: -32000, message: "command probe.run did not reply within 10000ms" });
  timers.tick(9999);
  assert.deepEqual(ofKind("timeout"), []);
  timers.tick(1);
  await rejected;
  assert.deepEqual(ofKind("timeout"), [{ kind: "timeout", plugin: "probe", command: "probe.run", timeout: 10000 }]);
});

test("a declared timeout replaces the default, up to the maximum of 600000 ms", async (t) => {
  const { calls, ofKind, timers } = setup(t);
  const failed = calls.request("probe.slow", {}, { timeout: 600000 });
  const rejected = assert.rejects(failed, { code: -32000, message: "command probe.slow did not reply within 600000ms" });
  timers.tick(599999);
  assert.deepEqual(ofKind("timeout"), []);
  timers.tick(1);
  await rejected;
  assert.equal(ofKind("timeout")[0].timeout, 600000);
});

test("a timeout outside the integer range from 1 to 600000 is rejected before anything is sent", (t) => {
  const { calls, transport } = setup(t);
  for (const timeout of [0, 600001, 1.5, "100", Number.NaN]) {
    assert.throws(() => calls.request("probe.run", {}, { timeout }), /timeout must be an integer from 1 to 600000 ms/);
  }
  assert.deepEqual(transport.sent, []);
  assert.deepEqual(calls.openCalls(), { count: 0, oldestStartedAt: null });
});

test("a reply before the limit clears the timer, so no timeout is counted", async (t) => {
  const { calls, transport, ofKind, timers } = setup(t);
  const done = calls.request("probe.run");
  transport.deliver({ id: 1, result: "ok" });
  assert.equal(await done, "ok");
  timers.tick(20000);
  assert.deepEqual(ofKind("timeout"), []);
});

test("a reply after the timeout is discarded and counted as a late reply with its delay", async (t) => {
  const { calls, transport, ofKind, timers } = setup(t);
  const failed = calls.request("probe.run", {}, { timeout: 1000 });
  const rejected = assert.rejects(failed, { code: -32000 });
  timers.tick(1000);
  await rejected;
  timers.tick(250);
  transport.deliver({ id: 1, result: "late" });
  assert.deepEqual(ofKind("late-reply"), [{ kind: "late-reply", plugin: "probe", command: "probe.run", delay: 1250 }]);
  assert.equal(ofKind("timeout").length, 1);
});

test("peer lost rejects every open call with the reason and reports each call", async (t) => {
  const { calls, ofKind, timers } = setup(t);
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
  timers.tick(20000);
  assert.deepEqual(ofKind("timeout"), []);
});

test("surface-closed and sidecar-ended end calls with their own reasons", async (t) => {
  const { calls, ofKind } = setup(t);
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

test("a peer-lost reason outside the declared reasons is rejected", (t) => {
  const { calls } = setup(t);
  assert.throws(() => calls.peerLost("unresponsive"), /peer lost reason must be one of process-ended, surface-closed, sidecar-ended/);
});

test("openCalls gives the count and the start time of the oldest open call, and each change is reported", async (t) => {
  const { calls, transport, ofKind, timers } = setup(t);
  const started = Date.now();
  const first = calls.request("probe.a");
  timers.tick(5);
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

test("a send that throws rejects the call with that error and leaves no open call", async (t) => {
  const { calls, ofKind } = setup(t, { send: () => { throw new Error("transport closed"); } });
  await assert.rejects(calls.request("probe.run"), /transport closed/);
  assert.deepEqual(calls.openCalls(), { count: 0, oldestStartedAt: null });
  assert.equal(ofKind("timeout").length, 0);
});

test("the last 256 ended calls are remembered, and a reply to an older ended call is refused", async (t) => {
  const { calls, transport, ofKind, timers } = setup(t);
  const ended = [];
  for (let index = 0; index < 257; index += 1) ended.push(calls.request("probe.run").catch(() => {}));
  timers.tick(10000);
  await Promise.all(ended);
  transport.deliver({ id: 257, result: 1 });
  assert.equal(ofKind("late-reply").length, 1);
  assert.throws(() => transport.deliver({ id: 1, result: 1 }), /call reply 1 has no matching request/);
});

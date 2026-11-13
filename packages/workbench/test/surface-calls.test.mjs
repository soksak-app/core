// The host calls of a surface document (docs/spec/logging.md#entrances): every call is the event `workbench.call`, the
// events of one turn travel in one `log` request, and the records of the document keep their order among the calls.
import assert from "node:assert/strict";
import test from "node:test";
import { surfaceCalls } from "../surface-calls.js";
import { logGate } from "../log-gate.js";
import { withoutClock } from "./support/records.mjs";

const TRACE = { lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" };
const ERRORS = { lifecycle: "error", input: "error", call: "error", io: "error", frame: "error" };

// The fake host answers the action policy-read with the classes given, and `emit` sends the host event log-policy to the document.
// The events below the level error are stored only in the debug state (docs/spec/settings.md, the section of core.settings.debug),
// which most tests examine, so the host answers every class at trace by default.
// read, when given, holds the answer of the read of the policy until it resolves.
function setup(send, classes = TRACE, read = null) {
  const requests = [];
  const listeners = new Map();
  const calls = surfaceCalls({
    send,
    log: async (request) => {
      if (request.action === "clock") return { ts_us: 1_791_000_000_000_456, mono_ns: 5_000_000_789 };
      if (request.action === "policy-read") {
        if (read) await read;
        return { classes };
      }
      requests.push(withoutClock(request));
    },
    listen: (name, fn) => { listeners.set(name, fn); },
  });
  // policy resolves when the read of the policy answered and its policy is in force.
  const policy = calls.followPolicy();
  const emit = (name, payload) => listeners.get(name)(payload);
  return { calls, requests, emit, policy, events: () => requests.flatMap((request) => request.events) };
}

test("a document applies the policy that the host reads at its load, and each later event log-policy", async () => {
  const { calls, emit, events, policy } = setup(async () => "answer", ERRORS);
  await policy;
  await calls.call("documentAttach", { document: "d" });
  await calls.record("error", "workbench.record.error", { where: "workbench", text: "first" });
  assert.deepEqual(events().map((event) => event.event), ["workbench.record.error"], "the default policy stores no workbench.call of level debug");
  emit("log-policy", { classes: TRACE });
  await calls.call("documentAttach", { document: "d" });
  await calls.record("info", "workbench.record.info", { where: "workbench", text: "second" });
  assert.deepEqual(events().map((event) => [event.event, event.fields.name ?? event.fields.text]).slice(1),
    [["workbench.call", "documentAttach"], ["workbench.record.info", "second"]]);
});

test("the policy that the host reads at the load is in force before the first call", async () => {
  // The gate starts at the default policy, and the read answers only when the check releases it, so the policy that the gate has at
  // the end of the wait comes from that answer.
  logGate.set(ERRORS);
  const read = Promise.withResolvers();
  const { calls, events, policy } = setup(async () => "answer", TRACE, read.promise);
  assert.deepEqual(logGate.classes(), ERRORS, "the policy changed before the read answered");
  read.resolve();
  await policy;
  assert.deepEqual(logGate.classes(), TRACE, "the wait for the policy ended before the answer of the read was in force");
  await calls.call("documentLoad", { document: "d" });
  await calls.record("info", "workbench.record.info", {});
  assert.deepEqual(events().map((event) => event.event), ["workbench.call", "workbench.record.info"]);
});

test("a call returns its answer and is recorded after it ended, with the duration and the outcome", async () => {
  const { calls, events } = setup(async (name, value) => ({ echoed: value }));
  assert.deepEqual(await calls.call("documentAttach", { document: "d" }), { echoed: { document: "d" } });
  await calls.record("info", "workbench.record.info", { where: "workbench", text: "after" });
  assert.deepEqual(events().map((event) => [event.event, event.level]), [["workbench.call", "debug"], ["workbench.record.info", "info"]]);
  const { fields } = events()[0];
  assert.equal(fields.name, "documentAttach");
  assert.equal(fields.args, '[{"document":"d"}]');
  assert.equal(fields.ok, true);
  assert.ok(Number.isInteger(fields.micros) && fields.micros >= 0);
});

test("a rejected call and a call that throws before sending are warn events, and the caller gets the same error", async () => {
  const failure = new Error("refused by the host");
  const { calls, events } = setup((name) => {
    if (name === "throws") throw failure;
    return Promise.reject(failure);
  });
  await assert.rejects(calls.call("rejects"), (error) => error === failure);
  await assert.rejects(calls.call("throws"), (error) => error === failure);
  await calls.record("info", "workbench.record.info", {});
  assert.deepEqual(events().slice(0, 2).map((event) => [event.level, event.fields.name, event.fields.ok, event.fields.error]), [
    ["warn", "rejects", false, "-32603: refused by the host"],
    ["warn", "throws", false, "-32603: refused by the host"],
  ]);
});

// The host calls of a surface document (docs/spec/logging.md#automatic-entrances): every call is the event `page.call`, the
// events of one turn travel in one `log` request, and the records of the document keep their order among the calls.
import assert from "node:assert/strict";
import test from "node:test";
import { surfaceCalls } from "../surface-calls.js";
import { settled, withoutClock } from "./support/records.mjs";

const TRACE = { lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" };
const ERRORS = { lifecycle: "error", input: "error", call: "error", io: "error", frame: "error" };

// The fake host answers the action policy-read with the classes given, and `emit` sends the host event log-policy to the document.
// The events below the level error are stored only in the debug state (docs/spec/settings.md, the section of core.settings.debug),
// which most tests examine, so the host answers every class at trace by default.
function setup(send, classes = TRACE) {
  const requests = [];
  const listeners = new Map();
  const calls = surfaceCalls({
    send,
    log: async (request) => {
      if (request.action === "clock") return { ts_us: 1_791_000_000_000_456, mono_ns: 5_000_000_789 };
      if (request.action === "policy-read") return { classes };
      requests.push(withoutClock(request));
    },
    listen: (name, fn) => { listeners.set(name, fn); },
  });
  calls.followPolicy();
  const emit = (name, payload) => listeners.get(name)(payload);
  return { calls, requests, emit, events: () => requests.flatMap((request) => request.events) };
}

test("a document applies the policy that the host reads at its load, and each later event log-policy", async () => {
  const { calls, emit, events } = setup(async () => "answer", ERRORS);
  await settled();
  await calls.call("documentAttach", { document: "d" });
  await calls.record("error", "page.record.error", { where: "page", text: "first" });
  assert.deepEqual(events().map((event) => event.event), ["page.record.error"], "the default policy stores no page.call of level debug");
  emit("log-policy", { classes: TRACE });
  await calls.call("documentAttach", { document: "d" });
  await calls.record("info", "page.record.info", { where: "page", text: "second" });
  assert.deepEqual(events().map((event) => [event.event, event.fields.name ?? event.fields.text]).slice(1),
    [["page.call", "documentAttach"], ["page.record.info", "second"]]);
});

test("the policy that the host reads at the load is in force before the first call", async () => {
  const { calls, events } = setup(async () => "answer");
  await settled();
  await calls.call("documentLoad", { document: "d" });
  await calls.record("info", "page.record.info", {});
  assert.deepEqual(events().map((event) => event.event), ["page.call", "page.record.info"]);
});

test("a call returns its answer and is recorded after it ended, with the duration and the outcome", async () => {
  const { calls, events } = setup(async (name, value) => ({ echoed: value }));
  assert.deepEqual(await calls.call("documentAttach", { document: "d" }), { echoed: { document: "d" } });
  await calls.record("info", "page.record.info", { where: "page", text: "after" });
  assert.deepEqual(events().map((event) => [event.event, event.level]), [["page.call", "debug"], ["page.record.info", "info"]]);
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
  await calls.record("info", "page.record.info", {});
  assert.deepEqual(events().slice(0, 2).map((event) => [event.level, event.fields.name, event.fields.ok, event.fields.error]), [
    ["warn", "rejects", false, "-32603: refused by the host"],
    ["warn", "throws", false, "-32603: refused by the host"],
  ]);
});

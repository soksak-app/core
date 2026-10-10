// The trace of the page (docs/spec/performance-trace.md, docs/spec/logging.md#writers): an event of the trace is the event
// `page.trace.<event>`, queued without waiting and relayed to the host in a batch through the call `log`; the switch is the
// call `performance`.
import test from "node:test";
import assert from "node:assert/strict";
import { createTracer } from "../performance.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A tracer whose switch calls and batch calls are recorded in the order they happen. */
function recorded(overrides = {}) {
  const calls = [];
  const tracer = createTracer(
    overrides.switch ?? (async (request) => { calls.push(["switch", request.action]); }),
    overrides.report ?? assert.ifError,
    overrides.log ?? (async (request) => { calls.push(["log", request.events]); }),
  );
  return { calls, tracer };
}

test("disabled page tracing does not format or relay a focus event", async (t) => {
  const calls = [];
  t.mock.module("@soksak/runtime", { exports: {
    host: { call: async (name, params) => { calls.push({ name, params }); } },
  } });
  const page = await import("../performance.js?disabled-focus");
  let formatted = 0;
  page.trace("focus", { get target() { formatted++; return "address"; } });
  await settle();
  assert.equal(calls.length, 0, "disabled tracing relayed a focus event");
  assert.equal(formatted, 0, "disabled tracing formatted a focus event");
});

test("an enabled trace relays its events of one turn in one log call, and the line has no timestamp of its own", async () => {
  const { calls, tracer } = recorded();
  await tracer.setEnabled(true);
  tracer.trace("action", { kind: "resize", width: 1200 });
  tracer.trace("focus", { phase: "in" });
  await settle();
  const logs = calls.filter(([kind]) => kind === "log");
  assert.equal(logs.length, 1, "the events of one turn travel in one call");
  const [first, second] = logs[0][1];
  assert.equal(first.event, "page.trace.action");
  assert.equal(first.level, "debug");
  assert.deepEqual({ kind: first.fields.kind, width: first.fields.width }, { kind: "resize", width: 1200 });
  assert.equal("ts" in first.fields, false, "the event carries ts_us, not a second timestamp");
  assert.ok(Number.isInteger(first.ts_us) && first.ts_us > 1.7e15);
  assert.equal(second.event, "page.trace.focus");
});

test("disabling stops new events at once and waits for the events that were accepted", async () => {
  let release;
  const calls = [];
  const tracer = createTracer(
    async (request) => { calls.push(request.action); },
    assert.ifError,
    (request) => { calls.push("log"); return new Promise((resolve) => { release = resolve; }); },
  );
  await tracer.setEnabled(true);
  tracer.trace("focus", {});
  await settle();
  const disabling = tracer.setEnabled(false);
  tracer.trace("focus", {});
  await settle();
  assert.deepEqual(calls, ["on", "log"], "the switch went off before the accepted event was relayed");
  release();
  await disabling;
  assert.deepEqual(calls, ["on", "log", "off"]);
});

test("a failed relay is reported with its event count and a failed switch rejects", async () => {
  const errors = [];
  const { tracer } = recorded({
    switch: async ({ action }) => { if (action === "off") throw new Error("switch failed"); },
    log: async () => { throw new Error("relay failed"); },
    report: (error) => errors.push(error.message),
  });
  await tracer.setEnabled(true);
  assert.equal(await tracer.timed("core.ok", async () => 42), 42);
  await assert.rejects(tracer.setEnabled(false), /switch failed/);
  assert.deepEqual(errors, ["page event batch of 1 events failed: relay failed"]);
});

test("timed reports the duration and passes the result and failure through", async () => {
  const { calls, tracer } = recorded();
  await tracer.setEnabled(true);
  assert.equal(await tracer.timed("core.ok", async () => 42), 42);
  await assert.rejects(tracer.timed("core.fail", async () => { throw new Error("boom"); }), /boom/);
  await tracer.setEnabled(false);
  const events = calls.filter(([kind]) => kind === "log").flatMap(([, batch]) => batch);
  assert.equal(events[0].event, "page.trace.command");
  assert.equal(events[0].fields.name, "core.ok");
  assert.equal(events[0].fields.ok, true);
  assert.ok(Number.isFinite(events[0].fields.us), "the duration is a number of microseconds");
  assert.equal(events[1].fields.ok, false);
  assert.equal(events[1].fields.error, "boom");
});

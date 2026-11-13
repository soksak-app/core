// The trace of the page (docs/spec/performance-trace.md, docs/spec/logging.md#writers): an event of the trace is the event
// `workbench.trace.<event>`, queued without waiting and relayed to the host in a batch through the call `log`; the switch is the
// call `performance`.
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBatcher } from "@soksak/plugin-api/log-batch.js";
import { createTracer } from "../performance.js";
import { withoutClock } from "./support/records.mjs";
import { classOf } from "../event-classes.js";
import { logGate } from "../log-gate.js";
import { pageIdentity } from "../page-identity.js";
// The events below the level error are stored only in the debug state (docs/spec/settings.md, the section of core.settings.debug), which these tests
// examine, so the state of every class at trace is set here.
logGate.set({ lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" });


// The request for the clocks of the host is answered here; the batches are what the tests assert.
const answering = (inner) => (request) => (request.action === "clock" ? Promise.resolve({ ts_us: 1_791_000_000_000_456, mono_ns: 5_000_000_789 }) : inner(withoutClock(request)));
/** The event writer of a document, as the page records have it, over the call log; report receives a failed relay. */
const writer = (log, report) => createEventBatcher({ writer: { layer: "workbench", member: "start", identity: pageIdentity }, call: answering(log), report, classify: classOf, gate: logGate });

/** A tracer whose switch calls and batch calls are recorded in the order they happen; batcher is its event writer, whose flush ends the relay of the events queued so far. */
function recorded(overrides = {}) {
  const calls = [];
  const batcher = writer(overrides.log ?? (async (request) => { calls.push(["log", request.events]); }), overrides.report ?? assert.ifError);
  const tracer = createTracer(overrides.switch ?? (async (request) => { calls.push(["switch", request.action]); }), batcher);
  return { calls, tracer, batcher };
}

test("a start of the page reports the stored switch to the host even when it is off", async () => {
  const { calls, tracer } = recorded();
  // A page starts with the trace off (the local state), but the switch of the host can be on from a page that ended;
  // the report at startup is what turns a stale switch off (#F161.36).
  await tracer.reportAtStart(false);
  assert.deepEqual(calls.filter(([kind]) => kind === "switch"), [["switch", "off"]],
    "the start of the page reports the stored off to the host");
});

test("disabled page tracing does not format or relay a focus event", async (t) => {
  const calls = [];
  t.mock.module("@soksak/runtime", { exports: {
    host: { call: async (name, params) => { calls.push({ name, params }); } },
  } });
  // The page tracer queues its events through emitEvent of the page log; the fake records each event and builds its payload, as
  // a gate that stores the event does, so a queued event and a formatted payload are both seen.
  const emitted = [];
  const actualLog = await import("../page-log.js");
  t.mock.module("../page-log.js", { exports: { ...actualLog, emitEvent: (level, event, fields) => {
    emitted.push(event);
    if (typeof fields === "function") fields();
  } } });
  const page = await import("../performance.js?disabled-focus");
  let formatted = 0;
  page.trace("focus", { get target() { formatted++; return "address"; } });
  assert.deepEqual(emitted, [], "disabled tracing queued a focus event");
  assert.equal(calls.length, 0, "disabled tracing relayed a focus event");
  assert.equal(formatted, 0, "disabled tracing formatted a focus event");
});

test("a layout phase uses the frame gate while the performance trace is off", async () => {
  const { calls, tracer, batcher } = recorded();
  logGate.set({ lifecycle: "off", input: "off", call: "off", io: "off", frame: "trace" });
  try {
    tracer.trace("layout", { phase: "queued", id: 1, t: 2 });
    tracer.trace("focus", { phase: "in" });
    await batcher.flush();
    const events = calls.filter(([kind]) => kind === "log").flatMap(([, batch]) => batch);
    assert.ok(events.some(({ event, fields }) => event === "workbench.trace.layout"
      && fields.phase === "queued" && fields.id === 1 && fields.t === 2),
    "the frame-gated layout phase is recorded while performance tracing is off");
    assert.equal(events.some(({ event }) => event === "workbench.trace.focus"), false,
      "call-class tracing remains off while the performance trace is off");
  } finally {
    logGate.set({ lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" });
  }
});

test("a closed frame gate does not format or relay a layout phase", async () => {
  const { calls, tracer, batcher } = recorded();
  logGate.set({ lifecycle: "off", input: "off", call: "off", io: "off", frame: "off" });
  let formatted = 0;
  try {
    tracer.trace("layout", { get phase() { formatted++; return "queued"; }, id: 1, t: 2 });
    await batcher.flush();
    const events = calls.filter(([kind]) => kind === "log").flatMap(([, batch]) => batch);
    assert.equal(events.some(({ event }) => event === "workbench.trace.layout"), false,
      "a closed frame gate stores no layout phase");
    assert.equal(formatted, 0, "a closed frame gate does not build layout fields");
  } finally {
    logGate.set({ lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" });
  }
});

test("an enabled trace relays its events of one turn in one log call, and the line has no timestamp of its own", async () => {
  const { calls, tracer, batcher } = recorded();
  await tracer.setEnabled(true);
  tracer.trace("action", { kind: "resize", width: 1200 });
  tracer.trace("focus", { phase: "in" });
  await batcher.flush();
  const logs = calls.filter(([kind]) => kind === "log");
  assert.equal(logs.length, 1, "the events of one turn travel in one call");
  const [first, second] = logs[0][1];
  assert.equal(first.event, "workbench.trace.action");
  assert.equal(first.level, "debug");
  assert.deepEqual({ kind: first.fields.kind, width: first.fields.width }, { kind: "resize", width: 1200 });
  assert.equal("ts" in first.fields, false, "the event carries ts_us, not a second timestamp");
  assert.ok(Number.isInteger(first.ts_us) && first.ts_us > 1.7e15);
  assert.equal(second.event, "workbench.trace.focus");
});

test("disabling stops new events at once and waits for the events that were accepted", { timeout: 1000 }, async () => {
  let release;
  // relayStarted resolves when the batch call of the accepted event starts; that call stays pending until release.
  let started;
  const relayStarted = new Promise((resolve) => { started = resolve; });
  const calls = [];
  const tracer = createTracer(
    async (request) => { calls.push(request.action); },
    writer((request) => { calls.push("log"); started(); return new Promise((resolve) => { release = resolve; }); }, assert.ifError),
  );
  await tracer.setEnabled(true);
  tracer.trace("focus", {});
  await relayStarted;
  const disabling = tracer.setEnabled(false);
  tracer.trace("focus", {});
  // The release runs in a microtask queued after the switch work of setEnabled(false), so a switch that went off without waiting for the relay
  // records "off" before "released". The event traced while disabling is not relayed.
  queueMicrotask(() => {
    calls.push("released");
    release();
  });
  await disabling;
  assert.deepEqual(calls, ["on", "log", "released", "off"], "the switch went off before the accepted event was relayed");
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
  // The first batch also holds the statement of the anchor (workbench.log.clock).
  assert.deepEqual(errors, ["page event batch of 2 events failed: relay failed"]);
});

test("timed reports the duration and passes the result and failure through", async () => {
  const { calls, tracer } = recorded();
  await tracer.setEnabled(true);
  assert.equal(await tracer.timed("core.ok", async () => 42), 42);
  await assert.rejects(tracer.timed("core.fail", async () => { throw new Error("boom"); }), /boom/);
  await tracer.setEnabled(false);
  const events = calls.filter(([kind]) => kind === "log").flatMap(([, batch]) => batch);
  assert.equal(events[0].event, "workbench.trace.command");
  assert.equal(events[0].fields.name, "core.ok");
  assert.equal(events[0].fields.ok, true);
  assert.ok(Number.isFinite(events[0].fields.us), "the duration is a number of microseconds");
  assert.equal(events[1].fields.ok, false);
  assert.equal(events[1].fields.error, "boom");
});

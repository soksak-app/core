// The trace of the page (docs/spec/performance-trace.md, docs/spec/logging.md#writers): an event of the trace is the event
// `workbench.trace.<event>`, queued without waiting and relayed to the host in a batch through the call `log`; the switch is the
// call `performance`. The host calls are answered by the page-wire case of each test (docs/spec/cases/page-wire/README.md).
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBatcher } from "@soksak/plugin-api/log-batch.js";
import { host, selectPageWire } from "@soksak/runtime";
import { withoutClock } from "./support/records.mjs";
import { logGate } from "../log-gate.js";
import { classOf } from "../event-classes.js";
import { pageIdentity } from "../page-identity.js";

// The page reads the host when it imports performance.js and page-log.js, so the case of the first test is selected before those imports.
const switchStart = selectPageWire("performance-switch-start");
const { commandFields, createTracer, reportTraceAtStart, setTraceEnabled, timed, trace } = await import("../performance.js");
const { flushEvents } = await import("../page-log.js");

// The events below the level error are stored only in the debug state (docs/spec/settings.md, the section of core.settings.debug), which these tests
// examine, so the state of every class at trace is set here.
const everyClassAtTrace = { lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" };
logGate.set(everyClassAtTrace);

/** The events of the batches of the log calls that the page sent, without the statement of the anchor (workbench.log.clock). */
const relayed = (wire) => wire.calls
  .filter((call) => call.name === "log" && call.payload.action === "batch")
  .flatMap((call) => withoutClock(call.payload).events);

test("a start of the page reports the stored switch to the host even when it is off", async () => {
  // A page starts with the trace off (the local state), but the switch of the host can be on from a page that ended;
  // the report at startup is what turns a stale switch off (#F161.36).
  await reportTraceAtStart(false);
  assert.deepEqual(switchStart.calls.filter((call) => call.name === "performance"), [{ name: "performance", payload: { action: "off" } }],
    "the start of the page reports the stored off to the host");
  switchStart.finish();
});

test("disabled page tracing does not format or relay a focus event", async () => {
  const wire = selectPageWire("performance-trace-off");
  let formatted = 0;
  trace("focus", { get target() { formatted++; return "address"; } });
  await flushEvents();
  assert.equal(wire.calls.length, 0, "disabled tracing sent a host call");
  assert.equal(formatted, 0, "disabled tracing formatted a focus event");
  wire.finish();
});

test("a layout phase uses the frame gate while the performance trace is off", async () => {
  const wire = selectPageWire("performance-frame-gate");
  logGate.set({ lifecycle: "off", input: "off", call: "off", io: "off", frame: "trace" });
  try {
    trace("layout", { phase: "queued", id: 1, t: 2 });
    trace("focus", { phase: "in" });
    await flushEvents();
    const events = relayed(wire);
    assert.ok(events.some(({ event, fields }) => event === "workbench.trace.layout"
      && fields.phase === "queued" && fields.id === 1 && fields.t === 2),
    "the frame-gated layout phase is recorded while performance tracing is off");
    assert.equal(events.some(({ event }) => event === "workbench.trace.focus"), false,
      "call-class tracing remains off while the performance trace is off");
    wire.finish();
  } finally {
    logGate.set(everyClassAtTrace);
  }
});

test("a closed frame gate does not format or relay a layout phase", async () => {
  const wire = selectPageWire("performance-frame-gate-closed");
  logGate.set({ lifecycle: "off", input: "off", call: "off", io: "off", frame: "off" });
  let formatted = 0;
  try {
    trace("layout", { get phase() { formatted++; return "queued"; }, id: 1, t: 2 });
    await flushEvents();
    const events = relayed(wire);
    assert.equal(events.some(({ event }) => event === "workbench.trace.layout"), false,
      "a closed frame gate stores no layout phase");
    assert.equal(formatted, 0, "a closed frame gate does not build layout fields");
    wire.finish();
  } finally {
    logGate.set(everyClassAtTrace);
  }
});

test("an enabled trace relays its events of one turn in one log call, and the line has no timestamp of its own", async () => {
  const wire = selectPageWire("performance-turn-batch");
  await setTraceEnabled(true);
  trace("action", { kind: "resize", width: 1200 });
  trace("focus", { phase: "in" });
  await flushEvents();
  const logs = wire.calls.filter((call) => call.name === "log");
  assert.equal(logs.length, 1, "the events of one turn travel in one call");
  const [first, second] = logs[0].payload.events;
  assert.equal(first.event, "workbench.trace.action");
  assert.equal(first.level, "debug");
  assert.deepEqual({ kind: first.fields.kind, width: first.fields.width }, { kind: "resize", width: 1200 });
  assert.equal("ts" in first.fields, false, "the event carries ts_us, not a second timestamp");
  assert.ok(Number.isInteger(first.ts_us) && first.ts_us > 1.7e15);
  assert.equal(second.event, "workbench.trace.focus");
  await setTraceEnabled(false);
  assert.deepEqual(wire.calls.map((call) => call.name), ["performance", "log", "performance"]);
  wire.finish();
});

test("disabling stops new events at once and waits for the events that were accepted", { timeout: 1000 }, async () => {
  const wire = selectPageWire("performance-disable-wait");
  await setTraceEnabled(true);
  trace("focus", {});
  // The batch of the accepted event is sent in a microtask; the case holds its reply until the test releases it.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(wire.calls.map((call) => call.name), ["performance", "log"], "the accepted event was not sent");
  const disabling = setTraceEnabled(false);
  trace("focus", {});
  // The release runs in a microtask queued after the switch work of setTraceEnabled(false), so the switch goes off after the
  // release. The event traced while disabling is not relayed.
  let callsAtRelease = null;
  queueMicrotask(() => {
    callsAtRelease = wire.calls.map((call) => call.name);
    wire.release();
  });
  await disabling;
  assert.deepEqual(callsAtRelease, ["performance", "log"], "the switch went off before the accepted event was relayed");
  assert.deepEqual(wire.calls.map((call) => call.name), ["performance", "log", "performance"]);
  wire.finish();
});

test("a failed relay is reported with its event count and a failed switch rejects", async () => {
  const wire = selectPageWire("performance-relay-failure");
  const errors = [];
  // The own writer of this test reports a failed relay to the list of errors, so the report is observed as a value.
  const tracer = createTracer(
    (request) => host.call("performance", request),
    createEventBatcher({ call: (request) => host.call("log", request), report: (error) => errors.push(error.message), classify: classOf,
      gate: logGate, writer: { layer: "workbench", member: "start", identity: pageIdentity } }),
  );
  await tracer.setEnabled(true);
  assert.equal(await tracer.timed("core.ok", async () => 42), 42);
  await assert.rejects(tracer.setEnabled(false), /switch failed/);
  // The first batch also holds the statement of the anchor (workbench.log.clock).
  assert.deepEqual(errors, ["page event batch of 2 events failed: relay failed"]);
  wire.finish();
});

test("timed reports the duration and passes the result and failure through", async () => {
  const wire = selectPageWire("performance-timed");
  await setTraceEnabled(true);
  assert.equal(await timed("core.ok", async () => 42), 42);
  await assert.rejects(timed("core.fail", async () => { throw new Error("boom"); }), /boom/);
  await setTraceEnabled(false);
  const events = relayed(wire);
  assert.equal(events[0].event, "workbench.trace.command");
  assert.equal(events[0].fields.name, "core.ok");
  assert.equal(events[0].fields.ok, true);
  assert.ok(Number.isFinite(events[0].fields.us), "the duration is a number of microseconds");
  assert.equal(events[1].fields.ok, false);
  assert.equal(events[1].fields.error, "boom");
  // The duration is a function of the instants that the operation reports: 1.5 ms is 1500 microseconds.
  assert.deepEqual(commandFields("core.ok", 10, 11.5, { ok: true }), { name: "core.ok", us: 1500, ok: true });
  assert.deepEqual(commandFields("core.fail", 2, 2.25, { ok: false, error: new Error("boom") }),
    { name: "core.fail", us: 250, ok: false, error: "boom" });
  assert.deepEqual(commandFields("core.fail", 2, 2, { ok: false, error: "plain text" }),
    { name: "core.fail", us: 0, ok: false, error: "plain text" });
  wire.finish();
});

// A page reload waits until the page has sent the reply of every exposure request it received, so a command that
// reloads its own window still answers (docs/spec/installation.md#applying-a-change).
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPageWire } from "@soksak/runtime";

// Each test selects its case before it calls the modules below, which read the host when they are imported. The first case is
// selected here for the imports; each test selects its own case.
let wire = selectPageWire("exposure-reply-wait");
const { connectExposure, registry, whenRepliesSent } = await import("../exposure.js");
const { logGate } = await import("../log-gate.js");
const { flushEvents } = await import("../page-log.js");
// The events below the level error are stored only in the debug state (docs/spec/settings.md, the section of core.settings.debug), which these tests
// examine, so the state of every class at trace is set here.
logGate.set({ lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" });

test("whenRepliesSent resolves after the reply of a running command request is sent", async () => {
  registry.declare("core", { status: [], element: [], commands: [{
    name: "core.fixture.wait", description: "Waits for the test.",
    params: { type: "object", properties: {} }, result: { type: "null" },
  }] });
  let release;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  registry.command("core.fixture.wait", () => new Promise((resolve) => { release = resolve; started(); }));
  await connectExposure({ settled: async () => {}, report: () => {} });
  wire.deliverNotice();
  let sent = false;
  const waiting = whenRepliesSent().then(() => { sent = wire.calls.some(({ name, payload }) => name === "exposureReply" && payload.id === 7); });
  await running;
  assert.equal(wire.calls.some(({ name }) => name === "exposureReply"), false, "the command answered before the test released it");
  release(null);
  await waiting;
  assert.equal(sent, true, "whenRepliesSent resolved before the reply was sent");
  // The event of the command is in the batch that flushEvents waits for, so the case ends after that batch.
  await flushEvents();
  wire.finish();
});

test("a command request is the event workbench.command with its name, duration and outcome", async () => {
  wire = selectPageWire("exposure-reply-command-events");
  registry.declare("core", { status: [], element: [], commands: [
    { name: "core.fixture.fine", description: "Succeeds.", params: { type: "object", properties: {} }, result: { type: "null" } },
    { name: "core.fixture.broken", description: "Fails.", params: { type: "object", properties: {} }, result: { type: "null" } },
  ] });
  registry.command("core.fixture.fine", () => null);
  registry.command("core.fixture.broken", () => { throw new Error("broken on purpose"); });
  await connectExposure({ settled: async () => {}, report: () => {} });
  wire.deliverNotice();
  wire.deliverNotice();
  await whenRepliesSent();
  // The events of both commands are queued before their replies, so the promise of flushEvents covers their relay.
  await flushEvents();
  const events = wire.calls.filter(({ name }) => name === "log").flatMap(({ payload }) => payload.events ?? []).filter(({ event }) => event === "workbench.command");
  // An event is stored when its command ends, so the order is the order of the ends.
  assert.deepEqual(events.map(({ level, fields }) => [level, fields.name, fields.ok, fields.error]).sort((a, b) => a[1].localeCompare(b[1])), [
    ["warn", "core.fixture.broken", false, "-32000: broken on purpose"],
    ["debug", "core.fixture.fine", true, undefined],
  ]);
  for (const { fields } of events) assert.ok(Number.isInteger(fields.micros) && fields.micros >= 0);
  wire.finish();
});

test("the reply of a surface request without a view mark or surface port passes the reply gate", async () => {
  wire = selectPageWire("exposure-reply-surface-gated");
  // A view whose page has not mounted has neither mark nor port, so the page answers its request itself; that reply is a reply of the surface.
  const { gateSurfaceReplies } = await import("../exposure.js");
  registry.declare("core", { status: [], element: [], commands: [{
    name: "core.fixture.gated", description: "Answers for the gate.",
    params: { type: "object", properties: {} }, result: { type: "string" },
  }] });
  registry.command("core.fixture.gated", () => "gated");
  await connectExposure({ settled: async () => {}, report: () => {} });
  const gated = [];
  gateSurfaceReplies((surface, send) => { gated.push(surface); return send(); });
  try {
    wire.deliverNotice();
    await whenRepliesSent();
    await flushEvents();
    assert.deepEqual(gated, ["fixture-view"], "the reply of the surface request did not pass the reply gate");
    assert.deepEqual(wire.calls.filter(({ name }) => name === "exposureReply").map(({ name, payload }) => [name, payload]), [["exposureReply", { id: 31, result: "gated" }]]);
    wire.finish();
  } finally {
    gateSurfaceReplies(null);
  }
});

test("whenRepliesSent ends the diagnostic holds of surface replies, so a reload sends the held reply", async () => {
  wire = selectPageWire("exposure-reply-held-reply");
  const { gateSurfaceReplies } = await import("../exposure.js");
  const { createSurfaceReplyHold } = await import("../surface-reply-hold.js");
  registry.declare("core", { status: [], element: [], commands: [{
    name: "core.fixture.held", description: "Answers into a hold.",
    params: { type: "object", properties: {} }, result: { type: "string" },
  }] });
  registry.command("core.fixture.held", () => "held");
  await connectExposure({ settled: async () => {}, report: () => {} });
  const lines = [];
  const hold = createSurfaceReplyHold((line) => { lines.push(line); return Promise.resolve(); });
  gateSurfaceReplies(hold.gate, hold.endAll);
  try {
    hold.hold("fixture-held");
    wire.deliverNotice();
    await hold.held("fixture-held");
    // The event of the held command reaches the host before the held reply is sent, so the batch of the page is sent first.
    await flushEvents();
    assert.deepEqual(wire.calls.filter(({ name }) => name === "exposureReply"), [], "the held reply was sent before the reload");
    // whenRepliesSent ends the holds before it waits, so the held reply is on its way when it is called.
    const sent = whenRepliesSent();
    assert.throws(() => hold.held("fixture-held"), /are not held/, "whenRepliesSent kept the hold of the reply");
    await sent;
    assert.deepEqual(wire.calls.filter(({ name }) => name === "exposureReply").map(({ name, payload }) => [name, payload]), [["exposureReply", { id: 41, result: "held" }]]);
    assert.deepEqual(lines, ['held exposure replies of surface "fixture-held" were sent after their hold ended (1)']);
    wire.finish();
  } finally {
    gateSurfaceReplies(null);
  }
});

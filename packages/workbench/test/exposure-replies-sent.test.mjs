// A page reload waits until the page has sent the reply of every exposure request it received, so a command that
// reloads its own window still answers (docs/spec/installation.md#applying-a-change).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { clockAnswer, settled } from "./support/records.mjs";

const handlers = new Map();
const calls = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: async (name, fn) => { handlers.set(name, fn); },
  page: (path) => path,
  call: async (name, payload) => { calls.push([name, payload]); return clockAnswer(name, payload); },
} } });
const { connectExposure, registry, whenRepliesSent } = await import("../exposure.js");
const { logGate } = await import("../log-gate.js");
// The events below the level error are stored only in the debug state (docs/spec/settings.md, the section of core.settings.debug), which these tests
// examine, so the state of every class at trace is set here.
logGate.set({ lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" });

test("whenRepliesSent resolves after the reply of a running command request is sent", async () => {
  registry.declare("core", { status: [], element: [], commands: [{
    name: "core.fixture.wait", description: "Waits for the test.",
    params: { type: "object", properties: {} }, result: { type: "null" },
  }] });
  let release;
  registry.command("core.fixture.wait", () => new Promise((resolve) => { release = resolve; }));
  await connectExposure({ settled: async () => {}, report: () => {} });
  handlers.get("exposure-request")({ id: 7, method: "command.run", params: { name: "core.fixture.wait", params: {} } });
  let sent = false;
  const waiting = whenRepliesSent().then(() => { sent = calls.some(([name, payload]) => name === "exposureReply" && payload.id === 7); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.some(([name]) => name === "exposureReply"), false, "the command answered before the test released it");
  release(null);
  await waiting;
  assert.equal(sent, true, "whenRepliesSent resolved before the reply was sent");
});

test("a command request is the event workbench.command with its name, duration and outcome", async () => {
  registry.declare("core", { status: [], element: [], commands: [
    { name: "core.fixture.fine", description: "Succeeds.", params: { type: "object", properties: {} }, result: { type: "null" } },
    { name: "core.fixture.broken", description: "Fails.", params: { type: "object", properties: {} }, result: { type: "null" } },
  ] });
  registry.command("core.fixture.fine", () => null);
  registry.command("core.fixture.broken", () => { throw new Error("broken on purpose"); });
  await connectExposure({ settled: async () => {}, report: () => {} });
  calls.length = 0;
  handlers.get("exposure-request")({ id: 21, method: "command.run", params: { name: "core.fixture.fine", params: {} } });
  handlers.get("exposure-request")({ id: 22, method: "command.run", params: { name: "core.fixture.broken", params: {} } });
  await whenRepliesSent();
  await settled();
  const events = calls.filter(([name]) => name === "log").flatMap(([, payload]) => payload.events ?? []).filter(({ event }) => event === "workbench.command");
  // An event is stored when its command ends, so the order is the order of the ends.
  assert.deepEqual(events.map(({ level, fields }) => [level, fields.name, fields.ok, fields.error]).sort((a, b) => a[1].localeCompare(b[1])), [
    ["warn", "core.fixture.broken", false, "-32000: broken on purpose"],
    ["debug", "core.fixture.fine", true, undefined],
  ]);
  for (const { fields } of events) assert.ok(Number.isInteger(fields.micros) && fields.micros >= 0);
});

test("the reply of a surface request without a view mark or surface port passes the reply gate", async () => {
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
    calls.length = 0;
    handlers.get("exposure-request")({ id: 31, surface: "fixture-view", method: "command.run", params: { name: "core.fixture.gated", params: {} } });
    await whenRepliesSent();
    assert.deepEqual(gated, ["fixture-view"], "the reply of the surface request did not pass the reply gate");
    assert.deepEqual(calls.filter(([name]) => name === "exposureReply"), [["exposureReply", { id: 31, result: "gated" }]]);
  } finally {
    gateSurfaceReplies(null);
  }
});

test("whenRepliesSent ends the diagnostic holds of surface replies, so a reload sends the held reply", async () => {
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
    calls.length = 0;
    handlers.get("exposure-request")({ id: 41, surface: "fixture-held", method: "command.run", params: { name: "core.fixture.held", params: {} } });
    await hold.held("fixture-held");
    assert.deepEqual(calls.filter(([name]) => name === "exposureReply"), [], "the held reply was sent before the reload");
    // The bound is the observation of the test: a reload that waits for a held reply fails the check instead of stopping the run.
    let observation;
    const sent = await Promise.race([
      whenRepliesSent().then(() => true),
      new Promise((resolve) => { observation = setTimeout(() => resolve(false), 2000); }),
    ]);
    clearTimeout(observation);
    assert.equal(sent, true, "whenRepliesSent waited for the reply that the hold kept");
    assert.deepEqual(calls.filter(([name]) => name === "exposureReply"), [["exposureReply", { id: 41, result: "held" }]]);
    assert.deepEqual(lines, ['held exposure replies of surface "fixture-held" were sent after their hold ended (1)']);
  } finally {
    gateSurfaceReplies(null);
  }
});

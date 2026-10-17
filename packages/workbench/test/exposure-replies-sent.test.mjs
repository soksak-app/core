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
// The events below the level error are stored only in the debug state (docs/spec/settings.md, 진단 section), which these tests
// examine, so the state of every class at trace is set here.
logGate.set({ lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" });

test("whenRepliesSent resolves after the reply of a running command request is sent", async () => {
  registry.declare("core", { status: [], dom: [], commands: [{
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

test("a command request is the event page.command with its name, duration and outcome", async () => {
  registry.declare("core", { status: [], dom: [], commands: [
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
  const events = calls.filter(([name]) => name === "log").flatMap(([, payload]) => payload.events ?? []).filter(({ event }) => event === "page.command");
  // An event is stored when its command ends, so the order is the order of the ends.
  assert.deepEqual(events.map(({ level, fields }) => [level, fields.name, fields.ok, fields.error]).sort((a, b) => a[1].localeCompare(b[1])), [
    ["warn", "core.fixture.broken", false, "-32000: broken on purpose"],
    ["debug", "core.fixture.fine", true, undefined],
  ]);
  for (const { fields } of events) assert.ok(Number.isInteger(fields.micros) && fields.micros >= 0);
});

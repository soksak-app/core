// A page reload waits until the page has sent the reply of every exposure request it received, so a command that
// reloads its own window still answers (docs/spec/installation.md#applying-a-change).
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const handlers = new Map();
const calls = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: async (name, fn) => { handlers.set(name, fn); },
  page: (path) => path,
  call: async (name, payload) => { calls.push([name, payload]); },
} } });
const { connectExposure, registry, whenRepliesSent } = await import("../exposure.js");

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

// A command has no time limit: it ends by its reply, by a handler that throws with its own error, or by the end of its peer
// (`timeout` in docs/spec/exposure.md). The main page runs a core command and the handler of a plugin command that a state module
// registered in it; neither starts a timer. Each handler here answers when the test resolves its deferred, so a check that the
// command still runs is made after the handler was entered, and the answer is checked after the test ends the handler.
import assert from "node:assert/strict";
import test from "node:test";

const { createRegistry } = await import("../exposure.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** A handler that resolves `entered` when the command runs it and answers with the deferred that the test settles. */
function heldHandler() {
  const reply = deferred();
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  return { reply, entered, run: () => { enter(); return reply.promise; } };
}

const coreExposes = () => ({
  commands: [{ name: "core.fixture.slow", description: "Slow.", params: { type: "object" }, result: { type: "integer" } }],
});
const pluginExposes = () => ({
  commands: [{ name: "probe.wait", description: "Waits.", params: { type: "object" }, result: {} }],
});

// contract: exposure.command.ends-by-reply-or-peer-end
test("a core command starts no timer and answers the result of its handler when the handler resolves", async (t) => {
  const made = createRegistry();
  made.declare("core", coreExposes());
  const handler = heldHandler();
  made.command("core.fixture.slow", handler.run);
  const timers = t.mock.method(globalThis, "setTimeout");
  const answer = made.handle({ method: "command.run", params: { name: "core.fixture.slow", params: {} } });
  await handler.entered;
  assert.equal(timers.mock.callCount(), 0, "the main page started a timer for a core command");
  handler.reply.resolve(7);
  assert.deepEqual(await answer, { result: 7 });
});

// contract: exposure.command.ends-by-reply-or-peer-end
test("a plugin command that a state module runs in the main page starts no timer and answers when its handler resolves", async (t) => {
  const made = createRegistry();
  made.declare("probe", pluginExposes());
  const handler = heldHandler();
  made.plugin("probe").command("probe.wait", handler.run);
  const timers = t.mock.method(globalThis, "setTimeout");
  const answer = made.handle({ method: "command.run", params: { name: "probe.wait", params: {} } });
  await handler.entered;
  assert.equal(timers.mock.callCount(), 0, "the main page started a timer for the handler of a state module");
  handler.reply.resolve({ waited: true });
  assert.deepEqual(await answer, { result: { waited: true } });
});

test("a plugin command whose state module handler rejects answers the error of the handler", async () => {
  const made = createRegistry();
  made.declare("probe", pluginExposes());
  const handler = heldHandler();
  made.plugin("probe").command("probe.wait", handler.run);
  const answer = made.handle({ method: "command.run", params: { name: "probe.wait", params: {} } });
  await handler.entered;
  handler.reply.reject(new Error("probe wait failed"));
  const { error } = await answer;
  assert.match(error.message, /probe wait failed/);
});

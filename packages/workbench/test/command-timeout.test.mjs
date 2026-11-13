import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { EXPOSURE_ERRORS } from "@soksak/plugin-api";

// Active timers of the process, by the runtime's own list: a timer that the code under test starts is listed until it fires.
const activeTimeouts = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

// A command that this document answers has no time limit: the reply of its handler, an error of its handler or the end of its
// peer ends it, and a core command then answers after its layout presents (`timeout` in docs/spec/exposure.md). Each handler and
// presentation here is a deferred that the test settles, and the active timers of the process are counted before and after, so that the test finds that no timer is started.
const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { createRegistry } = await import("../exposure.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const declare = (made, ...commands) => made.declare("core", {
  status: [], element: [],
  commands: commands.map((name) => ({ name, description: "Fixture.", params: { type: "object" }, result: {} })),
});

// contract: exposure.command.declaration-refuses-a-time-limit
test("a main-page command declaration with timeout is refused", () => {
  const made = createRegistry();
  assert.throws(() => made.declare("core", {
    status: [], element: [],
    commands: [{ name: "core.fixture.slow", description: "Slow.", params: { type: "object" }, result: {}, timeout: 50 }],
  }), { message: "core exposes core.fixture.slow: timeout is not a member of a command declaration" });
});

// contract: exposure.command.ends-by-reply-or-peer-end
test("a main-page command waits for its handler and then for its presentation, and starts no timer", async (t) => {
  const made = createRegistry();
  const presentation = deferred();
  let presenting;
  const asked = new Promise((resolve) => { presenting = resolve; });
  made.configure({ settled: () => { presenting(); return presentation.promise; } });
  declare(made, "core.fixture.drawn");
  const handler = deferred();
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  made.command("core.fixture.drawn", () => { enter(); return handler.promise; });
  const timers = activeTimeouts();
  let answered = false;
  const running = made.run("core.fixture.drawn", {}).finally(() => { answered = true; });
  await entered;
  handler.resolve(9);
  await asked;
  assert.equal(answered, false, "the command answered before its layout presented");
  presentation.resolve();
  assert.equal(await running, 9);
  assert.ok(activeTimeouts() <= timers, "the main page started a timer for a command");
});

test("a handler that throws fails its command with its own error and starts no timer", async (t) => {
  const made = createRegistry();
  declare(made, "core.fixture.throws", "core.fixture.rejects");
  made.command("core.fixture.throws", () => { throw new Error("fixture handler failed"); });
  made.command("core.fixture.rejects", () => Promise.reject(new Error("fixture handler rejected")));
  const timers = activeTimeouts();
  await assert.rejects(made.run("core.fixture.throws", {}), /fixture handler failed/);
  await assert.rejects(made.run("core.fixture.rejects", {}), /fixture handler rejected/);
  assert.ok(activeTimeouts() <= timers, "the main page started a timer for a command");
  const answer = await made.handle({ method: "command.run", params: { name: "core.fixture.throws", params: {} } });
  assert.equal(answer.error.code, EXPOSURE_ERRORS.failed);
});

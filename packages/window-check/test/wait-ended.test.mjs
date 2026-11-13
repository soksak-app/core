// A check that the test runner ends at its limit while it waits for a status names that wait, its message and the last value
// that the status had, so the failure tells what the check waited for and what the application showed instead (F779).
import assert from "node:assert/strict";
import test, { mock } from "node:test";

delete process.env.SOKSAK_APP;
delete process.env.SOKSAK_RUN_ID;
delete process.env.SOKSAK_RUN_FOLDER;

mock.module("../event-log.mjs", {
  namedExports: { readEventErrors: () => ({ errors: [] }), sessionEventBoot: () => 0, sessionEventStart: () => ({}) },
});
const { Session } = await import("../app.mjs");

/** A session whose watches see the values of `values` and never satisfy their predicate. */
function waitingSession(values) {
  const client = {
    endpoint: { pid: 20 },
    request: async () => null,
    watch: (_window, _name, predicate) => new Promise(() => {
      for (const value of values) predicate(value);
    }),
  };
  return new Session({ name: "tauriv2", binary: process.execPath, configDir: "/nonexistent" }, client);
}

/** The end of a check that the test runner gives in its after hooks, with the diagnostics that the session writes. */
function ended(failureType, message) {
  const diagnostics = [];
  return {
    diagnostics,
    t: { name: "probe check", diagnostic: (text) => diagnostics.push(text), error: Object.assign(new Error(message), { failureType }) },
  };
}

test("a check that the test runner ended while it waited for a status names the wait and the last value", { timeout: 5000 }, async () => {
  const session = waitingSession([{ responder: { surface: "tab-a" }, regions: [{ surface: "tab-b", focused: false }] }]);
  session.until("host.window", (window) => window.responder?.surface === "tab-b", "tab-b did not take the focus after its click");
  const { diagnostics, t } = ended("testTimeoutFailure", "test timed out after 120000ms");
  await session.checkEnded(t);
  assert.deepEqual(diagnostics, ['tauriv2: the check ended at its limit while it waited for host.window: tab-b did not take the ' +
    'focus after its click; the last value was {"responder":{"surface":"tab-a"},"regions":[{"surface":"tab-b","focused":false}]}']);
});

test("a check that failed in its own code names no wait", { timeout: 5000 }, async () => {
  const session = waitingSession([{ responder: null }]);
  session.until("host.window", () => false, "nothing came");
  const { diagnostics, t } = ended("testCodeFailure", "the frame differs");
  await session.checkEnded(t);
  assert.deepEqual(diagnostics, []);
});

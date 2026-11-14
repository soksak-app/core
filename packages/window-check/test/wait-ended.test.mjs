// A check that the test runner ends at its limit while it waits for a status names that wait, its message and the last value
// that the status had, so the failure tells what the check waited for and what the application showed instead (F779).
import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";

delete process.env.SOKSAK_APP;
delete process.env.SOKSAK_RUN_ID;
delete process.env.SOKSAK_RUN_FOLDER;
const { Session } = await import("../app.mjs");

/**
 * A session whose watch sees `value` from the case player and never satisfies its predicate. The player ends the case with the
 * value, so the watch stays open until the test closes the connection.
 */
async function waitingSession(t, value) {
  const server = await startCasePlayer("window-check-wait-never-satisfied", { values: { value } });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  return { session: new Session({ name: "tauriv2", binary: process.execPath, configDir: "/nonexistent" }, client), server };
}

/** The end of a check that the test runner gives in its after hooks, with the diagnostics that the session writes. */
function ended(failureType, message) {
  const diagnostics = [];
  return {
    diagnostics,
    t: { name: "probe check", diagnostic: (text) => diagnostics.push(text), error: Object.assign(new Error(message), { failureType }) },
  };
}

test("a check that the test runner ended while it waited for a status names the wait and the last value", { timeout: 5000 }, async (t) => {
  const { session } = await waitingSession(t, { responder: { surface: "tab-a" }, regions: [{ surface: "tab-b", focused: false }] });
  const seen = Promise.withResolvers();
  void session.until("host.window", (window) => { seen.resolve(); return window.responder?.surface === "tab-b"; },
    "tab-b did not take the focus after its click").catch(() => {});
  await seen.promise;
  const { diagnostics, t: end } = ended("testTimeoutFailure", "test timed out after 120000ms");
  await session.checkEnded(end);
  assert.deepEqual(diagnostics, ['tauriv2: the check ended at its limit while it waited for host.window: tab-b did not take the ' +
    'focus after its click; the last value was {"responder":{"surface":"tab-a"},"regions":[{"surface":"tab-b","focused":false}]}']);
});

test("a check that failed in its own code names no wait", { timeout: 5000 }, async (t) => {
  const { session } = await waitingSession(t, { responder: null });
  const seen = Promise.withResolvers();
  void session.until("host.window", () => { seen.resolve(); return false; }, "nothing came").catch(() => {});
  await seen.promise;
  const { diagnostics, t: end } = ended("testCodeFailure", "the frame differs");
  await session.checkEnded(end);
  assert.deepEqual(diagnostics, []);
});

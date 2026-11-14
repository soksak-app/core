// An application whose document does not answer a request until the test runner ends the check at its limit is recorded as not
// replying in its configuration folder, and every later request and check of that application fails at once with that record
// instead of waiting for the limit of each check (F351).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";

delete process.env.SOKSAK_APP;
delete process.env.SOKSAK_RUN_ID;
delete process.env.SOKSAK_RUN_FOLDER;

const { open, Session } = await import("../app.mjs");

/** The end of a check that the test runner gives in its after hooks: the error and its failure type. */
const ended = (failureType, message) => ({ name: "probe check", error: Object.assign(new Error(message), { failureType }) });

/**
 * A session whose requests stay unanswered: the case player receives status.get and answers nothing, until the test closes the
 * connection, which rejects each request.
 */
async function silentSession(t) {
  const configDir = mkdtempSync(join(tmpdir(), "soksak-unresponsive-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const app = { name: "wailsv3", binary: process.execPath, configDir };
  const server = await startCasePlayer("window-check-request-unanswered");
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  const session = new Session(app, client);
  session.check = "probe check";
  // The close of the client drops a frame that it has not flushed, so the close waits until the player has received the request.
  const received = server.nextRequest("status.get");
  return { app, configDir, session, close: async () => { await received; client.close(); } };
}

test("a check that the test runner ended while a request had no answer makes the later checks of its application fail at once", async (t) => {
  const { app, configDir, session, close } = await silentSession(t);
  const unanswered = assert.rejects(session.get("core.settings"), /connection closed/);
  session.stallSamples.add(Promise.resolve({ line: "wailsv3 status.get core.settings still pending after 3000 ms; the host's threads at that moment: /x/logs/stall-20-7.txt" }));
  await session.checkEnded(ended("testTimeoutFailure", "test timed out after 600000ms"));
  const record = JSON.parse(readFileSync(join(configDir, "unresponsive.json"), "utf8"));
  assert.equal(record.check, "probe check");
  assert.equal(record.request, "wailsv3 status.get core.settings");
  assert.match(record.error, /^wailsv3 status\.get core\.settings had no answer when the test runner ended the check: test timed out after 600000ms; /);
  assert.match(record.error, /stall-20-7\.txt/);
  await assert.rejects(session.get("core.workbench.error"),
    /^Error: wailsv3 stopped replying in the check "probe check" at wailsv3 status\.get core\.settings, so this request is not sent; /);
  await assert.rejects(open({ name: "a later check" }, app),
    /^Error: wailsv3 stopped replying in the check "probe check" at wailsv3 status\.get core\.settings, so this check does not run; /);
  await close();
  await unanswered;
});

test("a check that failed in its own code leaves no record while a request is in flight", async (t) => {
  const { configDir, session, close } = await silentSession(t);
  const unanswered = assert.rejects(session.get("core.settings"), /connection closed/);
  await session.checkEnded(ended("testCodeFailure", "the frame differs"));
  assert.equal(existsSync(join(configDir, "unresponsive.json")), false);
  await close();
  await unanswered;
});

test("a check that the test runner ended after every request was answered leaves no record", async (t) => {
  const { configDir, session, close } = await silentSession(t);
  const answered = assert.rejects(session.get("core.settings"), /connection closed/);
  await close();
  await answered;
  await session.checkEnded(ended("testTimeoutFailure", "test timed out after 600000ms"));
  assert.equal(existsSync(join(configDir, "unresponsive.json")), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { PERSON, personAnswers, personOptions, recordingOptions, Session } from "../app.mjs";

// A session whose client records the requests it receives.
function session(t) {
  const sent = [];
  const client = { endpoint: { pid: 1 }, request: async (method) => { sent.push(method); return {}; } };
  const checked = new Session({ name: "wailsv3", configDir: "/nonexistent" }, client);
  const previous = process.env.SOKSAK_CHECK_DISPLAY;
  t.after(() => { if (previous === undefined) delete process.env.SOKSAK_CHECK_DISPLAY; else process.env.SOKSAK_CHECK_DISPLAY = previous; });
  return { checked, sent };
}

test("a check that records the screen is skipped before it starts when no display presents frames", { timeout: 1000 }, () => {
  assert.deepEqual(recordingOptions({ SOKSAK_CHECK_DISPLAY: "absent" }), {
    skip: "the check records the screen, which needs a display that presents frames; the local window checks run it",
  });
  assert.deepEqual(recordingOptions({}), {});
  assert.throws(() => recordingOptions({ SOKSAK_CHECK_DISPLAY: "none" }), /SOKSAK_CHECK_DISPLAY is "none"; it is unset or absent/);
});

test("a recording of a check that does not declare it fails without a display and sends no request", { timeout: 1000 }, async (t) => {
  const { checked, sent } = session(t);
  process.env.SOKSAK_CHECK_DISPLAY = "absent";
  await assert.rejects(checked.request("diagnostics.capture.start", {}),
    /wailsv3 diagnostics.capture.start: the check records the screen without a display that presents frames and does not declare it with RECORDING of @soksak\/window-check/);
  // A drag that the host records is a recording too.
  await assert.rejects(checked.request("diagnostics.drag", { capture: true }),
    /wailsv3 diagnostics.drag: the check records the screen without a display that presents frames and does not declare it/);
  assert.deepEqual(sent, []);
  await checked.request("diagnostics.drag", { capture: false });
  assert.deepEqual(sent, ["diagnostics.drag"]);
  sent.length = 0;
  // A still capture reads the window and needs no presented frames, so it runs.
  await checked.request("diagnostics.capture.still", {});
  assert.deepEqual(sent, ["diagnostics.capture.still"]);
});

test("a run with a display sends a recording", { timeout: 1000 }, async (t) => {
  const { checked, sent } = session(t);
  delete process.env.SOKSAK_CHECK_DISPLAY;
  await checked.request("diagnostics.capture.start", {});
  assert.deepEqual(sent, ["diagnostics.capture.start"]);
});

test("a check that needs a system authorization answered by a person is skipped when no person answers", { timeout: 1000 }, () => {
  assert.equal(personAnswers({ SOKSAK_CHECK_PERSON: "absent" }), false);
  assert.equal(personAnswers({}), true);
  assert.deepEqual(personOptions({ SOKSAK_CHECK_PERSON: "absent" }), {
    skip: "the check needs a system authorization that a person answers; the local window checks run it",
  });
  assert.deepEqual(personOptions({}), {});
  assert.throws(() => personOptions({ SOKSAK_CHECK_PERSON: "yes" }), /SOKSAK_CHECK_PERSON is "yes"; it is unset or absent/);
  assert.throws(() => personAnswers({ SOKSAK_CHECK_PERSON: "" }), /SOKSAK_CHECK_PERSON is ""; it is unset or absent/);
});

test("the person options of this run are frozen and spread into a check's options", { timeout: 1000 }, () => {
  assert.equal(Object.isFrozen(PERSON), true);
  assert.deepEqual({ ...PERSON, timeout: 5 }, { timeout: 5, ...personOptions(process.env) });
});

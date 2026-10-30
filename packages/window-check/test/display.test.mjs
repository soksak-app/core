import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../app.mjs";

// A session whose client records the requests it receives, and a test context that records a skip.
function session(t) {
  const sent = [];
  const skips = [];
  const client = { endpoint: { pid: 1 }, request: async (method, params) => { sent.push(method); return {}; } };
  const checked = new Session({ name: "wailsv3", configDir: "/nonexistent" }, client);
  checked.test = { skip: (reason) => skips.push(reason), diagnostic: () => {} };
  const previous = process.env.SOKSAK_CHECK_DISPLAY;
  t.after(() => { if (previous === undefined) delete process.env.SOKSAK_CHECK_DISPLAY; else process.env.SOKSAK_CHECK_DISPLAY = previous; });
  return { checked, sent, skips };
}

test("a recording of a run without a display skips its check with the reason and sends no request", { timeout: 1000 }, async (t) => {
  const { checked, sent, skips } = session(t);
  process.env.SOKSAK_CHECK_DISPLAY = "absent";
  await assert.rejects(checked.request("diagnostics.capture.start", {}), /needs a display that presents frames/);
  assert.equal(skips.length, 1, "the check was not skipped");
  assert.match(skips[0], /needs a display that presents frames/);
  assert.deepEqual(sent, []);
  // A still capture reads the window and needs no presented frames, so it runs.
  await checked.request("diagnostics.capture.still", {});
  assert.deepEqual(sent, ["diagnostics.capture.still"]);
});

test("a run with a display sends a recording, and another value of SOKSAK_CHECK_DISPLAY is an error", { timeout: 1000 }, async (t) => {
  const { checked, sent, skips } = session(t);
  delete process.env.SOKSAK_CHECK_DISPLAY;
  await checked.request("diagnostics.capture.start", {});
  assert.deepEqual(sent, ["diagnostics.capture.start"]);
  assert.deepEqual(skips, []);
  process.env.SOKSAK_CHECK_DISPLAY = "none";
  assert.throws(() => checked.request("diagnostics.capture.start", {}), /SOKSAK_CHECK_DISPLAY is "none"; it is unset or absent/);
});

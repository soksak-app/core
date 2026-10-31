import assert from "node:assert/strict";
import test from "node:test";
import * as harness from "../app.mjs";

// Window checks are end-to-end checks that run only on a computer with a display and a person (docs/operations/examples.md#test-kinds),
// so the harness has no path for a run without them.
test("the harness exports no options that skip a check in a run without a display or a person", { timeout: 1000 }, () => {
  const names = Object.keys(harness).filter((name) =>
    ["RECORDING", "PERSON", "displayPresents", "recordingOptions", "personAnswers", "personOptions"].includes(name));
  assert.deepEqual(names, []);
});

test("a recording request is sent whatever the environment of the run holds", { timeout: 1000 }, async (t) => {
  const sent = [];
  const client = { endpoint: { pid: 1 }, request: async (method) => { sent.push(method); return {}; } };
  const checked = new harness.Session({ name: "wailsv3", configDir: "/nonexistent" }, client);
  const previous = process.env.SOKSAK_CHECK_DISPLAY;
  t.after(() => { if (previous === undefined) delete process.env.SOKSAK_CHECK_DISPLAY; else process.env.SOKSAK_CHECK_DISPLAY = previous; });
  process.env.SOKSAK_CHECK_DISPLAY = "absent";
  await checked.request("diagnostics.capture.start", {});
  await checked.request("diagnostics.drag", { capture: true });
  assert.deepEqual(sent, ["diagnostics.capture.start", "diagnostics.drag"]);
});

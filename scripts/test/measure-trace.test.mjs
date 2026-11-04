import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyTrace, parseTrace, traceSettings } from "../measure-trace.mjs";

test("TRACE is 0 or 1, and any other value or no value is an error that names it", () => {
  assert.equal(parseTrace("0"), 0);
  assert.equal(parseTrace("1"), 1);
  for (const text of ["2", "on", " 1", "01", "true"]) {
    assert.throws(() => parseTrace(text), new Error(`TRACE must be 0 or 1, not ${JSON.stringify(text)}`));
  }
  assert.throws(() => parseTrace(""), new Error("TRACE must be 0 or 1, not set"));
  assert.throws(() => parseTrace(undefined), new Error("TRACE must be 0 or 1, not set"));
});

test("TRACE 0 turns the trace off under the default policy, and TRACE 1 turns it on with the classes call and frame at debug", () => {
  assert.deepEqual(traceSettings(0), { "diagnostics.performance": false, "diagnostics.log": {} });
  assert.deepEqual(traceSettings(1), { "diagnostics.performance": true, "diagnostics.log": { call: "debug", frame: "debug" } });
  assert.throws(() => traceSettings(2), new Error("TRACE must be 0 or 1, not 2"));
});

/** The policy file that the host writes for a value of the setting diagnostics.log (docs/spec/logging.md#policy-file). */
function writePolicy(configDir, classes) {
  const every = { lifecycle: "error", input: "error", call: "error", io: "error", frame: "error", ...classes };
  writeFileSync(join(configDir, "log-policy.json"), JSON.stringify({ schema: 1, classes: every }));
}

test("applying a trace state changes each setting through core.settings.change and resolves when the policy file holds its policy", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "measure-trace-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const calls = [];
  const run = async (command, params) => {
    calls.push([command, params]);
    // The host writes the policy file after the page received the change of diagnostics.log.
    if (params.key === "diagnostics.log") setTimeout(() => writePolicy(configDir, params.value), 50);
    return null;
  };
  await applyTrace(run, 1, configDir);
  assert.deepEqual(calls, [
    ["core.settings.change", { key: "diagnostics.log", value: { call: "debug", frame: "debug" }, scope: "common" }],
    ["core.settings.change", { key: "diagnostics.performance", value: true, scope: "common" }],
  ]);
  calls.length = 0;
  await applyTrace(run, 0, configDir);
  assert.deepEqual(calls, [
    ["core.settings.change", { key: "diagnostics.log", value: {}, scope: "common" }],
    ["core.settings.change", { key: "diagnostics.performance", value: false, scope: "common" }],
  ]);
});

test("applying a trace state fails with the policy that the file holds when the host does not write the policy", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "measure-trace-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  writePolicy(configDir, { input: "trace" });
  await assert.rejects(applyTrace(async () => null, 1, configDir, 300),
    /log-policy\.json did not hold the log policy .*"call":"debug".*"frame":"debug".* within 300 ms; it holds .*"input":"trace"/);
});

test("a refused command fails the application of the trace state with its error", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "measure-trace-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  await assert.rejects(applyTrace(async () => { throw new Error("sok: unknown setting"); }, 0, configDir), /sok: unknown setting/);
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { policyFile, policyOfSetting } from "@soksak/window-check/log-policy.mjs";
import { b3Conditions, b3Target, fixtureSettings, withB3Out } from "../benchmark/cases/b3-run.mjs";
import { B3_MEASUREMENTS } from "../benchmark/measurements.mjs";

const FRAME_DEBUG = policyOfSetting({ frame: "debug" }).classes;
const CONDITIONS = { refreshRate: 120, refreshRates: { w1: 120 }, backingScale: 2, traceState: false, logPolicy: FRAME_DEBUG, window: { width: 1200, height: 760 }, occluded: false, active: true };

function folder(t) {
  const path = mkdtempSync(join(tmpdir(), "b3-run-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

/** The conditions that b3Conditions returns for a window of the size `content` whose status stays the same. */
async function started(t, content = CONDITIONS.window) {
  const configDir = folder(t);
  writeFileSync(policyFile(configDir), JSON.stringify({ schema: 1, classes: FRAME_DEBUG }));
  const settings = { "diagnostics.performance": false, "diagnostics.log": { frame: "debug" } };
  return b3Conditions({
    window: "w1", app: { configDir },
    get: async (name) => (name === "core.settings" ? { values: settings } : { refreshRate: 120, scale: 2, content, occluded: false, active: true }),
  }, settings);
}

test("the conditions of a B3 run are host.window of its window, its diagnostics.performance and the classes of its policy file, which hold the settings of the benchmark", { timeout: 5000 }, async (t) => {
  const configDir = folder(t);
  writeFileSync(policyFile(configDir), JSON.stringify({ schema: 1, classes: FRAME_DEBUG }));
  const s = {
    window: "w1",
    app: { configDir },
    get: async (name) => {
      if (name === "host.window") return { pageProcess: null, frames: 40, refreshRate: 120, scale: 2, content: { width: 1200, height: 760 }, occluded: false, active: true };
      if (name === "core.settings") return { values: { "diagnostics.performance": false, "diagnostics.log": { frame: "debug" } } };
      throw new Error(`unexpected status ${name}`);
    },
  };
  const applied = { "diagnostics.performance": false, "diagnostics.log": { frame: "debug" } };
  assert.deepEqual(await b3Conditions(s, applied), CONDITIONS);
  const other = { "diagnostics.performance": true, "diagnostics.log": { call: "debug", frame: "debug" } };
  await assert.rejects(b3Conditions(s, other), new Error(
    `the window runs with diagnostics.performance false and the log classes ${JSON.stringify(FRAME_DEBUG)}, not the settings ` +
    `${JSON.stringify(other)} of the benchmark, whose log classes are ${JSON.stringify(policyOfSetting(other["diagnostics.log"]).classes)}`));
});

test("the fixture of a benchmark takes the trace and the log policy of its settings", { timeout: 5000 }, () => {
  assert.deepEqual(fixtureSettings({ "diagnostics.performance": true, "diagnostics.log": { call: "debug", frame: "trace" } }),
    { performanceTrace: true, log: { call: "debug", frame: "trace" }, measure: true });
});

test("a benchmark of one state writes B3 output with SOKSAK_B3_OUT and refuses SOKSAK_B3_TRACE", { timeout: 5000 }, () => {
  const keys = B3_MEASUREMENTS["idle-tab"];
  assert.equal(b3Target({}, keys), null);
  assert.deepEqual(b3Target({ SOKSAK_B3_OUT: "/tmp/out.json" }, keys), { path: "/tmp/out.json", state: null, keys });
  assert.throws(() => b3Target({ SOKSAK_B3_OUT: "" }, keys), new Error("SOKSAK_B3_OUT must be the path of the B3 output file or unset, not empty"));
  assert.throws(() => b3Target({ SOKSAK_B3_OUT: "/tmp/out.json", SOKSAK_B3_TRACE: "0" }, keys),
    new Error("SOKSAK_B3_TRACE names the state of a benchmark that measures in two, and this benchmark measures in one; it must be unset, not \"0\""));
});

test("a benchmark of two states writes the keys of the state that SOKSAK_B3_TRACE names, one of its state names, and needs both variables or neither", { timeout: 5000 }, () => {
  const declared = B3_MEASUREMENTS["view-drag"];
  assert.equal(b3Target({}, declared), null);
  assert.deepEqual(b3Target({ SOKSAK_B3_OUT: "/tmp/out.json", SOKSAK_B3_TRACE: "frame-records" }, declared),
    { path: "/tmp/out.json", state: "frame-records", keys: declared["frame-records"] });
  assert.deepEqual(b3Target({ SOKSAK_B3_OUT: "/tmp/out.json", SOKSAK_B3_TRACE: "0" }, declared),
    { path: "/tmp/out.json", state: "0", keys: declared["0"] });
  assert.throws(() => b3Target({ SOKSAK_B3_OUT: "/tmp/out.json" }, declared),
    new Error("SOKSAK_B3_OUT and SOKSAK_B3_TRACE are set together or not at all; SOKSAK_B3_OUT is set and SOKSAK_B3_TRACE is not"));
  assert.throws(() => b3Target({ SOKSAK_B3_TRACE: "0" }, declared),
    new Error("SOKSAK_B3_OUT and SOKSAK_B3_TRACE are set together or not at all; SOKSAK_B3_TRACE is set and SOKSAK_B3_OUT is not"));
  assert.throws(() => b3Target({ SOKSAK_B3_OUT: "/tmp/out.json", SOKSAK_B3_TRACE: "1" }, declared),
    new Error("SOKSAK_B3_TRACE: TRACE must be 0 or frame-records, not \"1\""));
  const resize = B3_MEASUREMENTS["resize-catch-up"];
  assert.deepEqual(b3Target({ SOKSAK_B3_OUT: "/tmp/out.json", SOKSAK_B3_TRACE: "captured" }, resize),
    { path: "/tmp/out.json", state: "captured", keys: resize.captured });
  assert.throws(() => b3Target({ SOKSAK_B3_OUT: "/tmp/out.json", SOKSAK_B3_TRACE: "0" }, resize),
    new Error("SOKSAK_B3_TRACE: TRACE must be captured or frame-records, not \"0\""));
});

test("a benchmark writes its values, its conditions and its verdict through the B3 writer, also when it fails", { timeout: 5000 }, async (t) => {
  const path = join(folder(t), "out.json");
  const target = { path, state: "0", keys: B3_MEASUREMENTS["view-drag"]["0"] };
  await withB3Out(target, async (run) => {
    assert.equal(run.state, "0");
    run.conditions = await started(t);
    run.measurements.dragCpuSeconds = 0.5;
  });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { measurements: { dragCpuSeconds: 0.5, verdict: "passed" }, conditions: CONDITIONS });

  const failed = join(folder(t), "out.json");
  await assert.rejects(withB3Out({ ...target, path: failed }, async (run) => {
    run.conditions = await started(t);
    run.measurements.dragCpuSeconds = 0.7;
    throw new Error("the drag lost a frame");
  }), new Error("the drag lost a frame"));
  assert.deepEqual(JSON.parse(readFileSync(failed, "utf8")), { measurements: { dragCpuSeconds: 0.7, verdict: "failed" }, conditions: CONDITIONS });

  const values = join(folder(t), "out.json");
  await withB3Out({ path: values, state: null, keys: B3_MEASUREMENTS["idle-tab"] }, async (run) => {
    run.conditions = await started(t);
    run.measurements.idleTabCostKb = 42000;
  });
  assert.deepEqual(JSON.parse(readFileSync(values, "utf8")).measurements, { idleTabCostKb: 42000 });
});

test("a value that the benchmark does not declare, or outside the form of the B3 output, is refused and nothing is written", { timeout: 5000 }, async (t) => {
  const path = join(folder(t), "out.json");
  await assert.rejects(withB3Out({ path, state: null, keys: B3_MEASUREMENTS["idle-tab"] }, async (run) => {
    run.conditions = await started(t);
    run.measurements.idleTabCost = 1;
  }), new Error("B3 measurement idleTabCost is not declared for this benchmark; it declares idleTabCostKb, documentPartKb"));
  await assert.rejects(withB3Out({ path, state: null, keys: B3_MEASUREMENTS["idle-tab"] }, async (run) => {
    run.conditions = await started(t);
    run.measurements.idleTabCostKb = Number.NaN;
  }), new Error("B3 measurement idleTabCostKb must be a finite number, \"passed\" or \"failed\", not NaN"));
  assert.throws(() => readFileSync(path), { code: "ENOENT" });
});

test("a run that fails before it read its conditions writes nothing and reports both causes", { timeout: 5000 }, async (t) => {
  const path = join(folder(t), "out.json");
  await assert.rejects(withB3Out({ path, state: null, keys: B3_MEASUREMENTS["section-view"] }, async () => { throw new Error("no window"); }),
    (error) => error instanceof AggregateError && error.errors[0].message === "no window" &&
      error.errors[1].message === "the B3 conditions of a benchmark are the object that b3Conditions returned, which withB3Out reads again when it writes, not undefined");
  assert.throws(() => readFileSync(path), { code: "ENOENT" });
});

test("without a B3 target a benchmark runs as a window check and writes nothing", { timeout: 5000 }, async () => {
  let ran = false;
  const run = await withB3Out(null, async (current) => { ran = true; assert.equal(current.state, null); });
  assert.equal(ran, true);
  assert.deepEqual(run.measurements, {});
});

test("the tests of one benchmark file add to one B3 output under the same conditions, and its verdict fails when any of them failed",
  { timeout: 5000 }, async (t) => {
    const path = join(folder(t), "out.json");
    const target = { path, state: null, keys: B3_MEASUREMENTS["section-view"] };
    await withB3Out(target, async (run) => { run.conditions = await started(t); });
    await assert.rejects(withB3Out(target, async (run) => { run.conditions = await started(t); throw new Error("reclaim returned 80%"); }),
      new Error("reclaim returned 80%"));
    await withB3Out(target, async (run) => { run.conditions = await started(t); });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { measurements: { verdict: "failed" }, conditions: CONDITIONS });
    const values = join(folder(t), "values.json");
    const idle = { path: values, state: null, keys: B3_MEASUREMENTS["idle-tab"] };
    await withB3Out(idle, async (run) => { run.conditions = await started(t); run.measurements.idleTabCostKb = 1; });
    await assert.rejects(withB3Out(idle, async (run) => { run.conditions = await started(t); run.measurements.idleTabCostKb = 2; }),
      new Error(`${values}: B3 measurement idleTabCostKb was written by an earlier test of the run`));
    const other = { ...CONDITIONS, window: { width: 1000, height: 760 } };
    await assert.rejects(withB3Out(target, async (run) => { run.conditions = await started(t, other.window); }),
      new Error(`${path}: the conditions ${JSON.stringify(other)} of this test differ from the conditions ${JSON.stringify(CONDITIONS)} of an earlier test of the run`));
  });

test("a benchmark records whether its window is covered when it writes, and a window covered at the start stays recorded", { timeout: 5000 }, async (t) => {
  const configDir = folder(t);
  writeFileSync(policyFile(configDir), JSON.stringify({ schema: 1, classes: FRAME_DEBUG }));
  const settings = { "diagnostics.performance": false, "diagnostics.log": { frame: "debug" } };
  const session = (readings) => ({
    window: "w1", app: { configDir },
    get: async (name) => {
      if (name === "core.settings") return { values: settings };
      if (name !== "host.window") throw new Error(`unexpected status ${name}`);
      return { refreshRate: 120, scale: 2, content: { width: 1200, height: 760 }, occluded: readings.shift(), active: true };
    },
  });
  const written = async (readings) => {
    const path = join(folder(t), "out.json");
    await withB3Out({ path, state: null, keys: B3_MEASUREMENTS["idle-tab"] }, async (run) => {
      run.conditions = await b3Conditions(session(readings), settings);
      run.measurements.idleTabCostKb = 1;
    });
    return JSON.parse(readFileSync(path, "utf8")).conditions.occluded;
  };
  assert.equal(await written([false, false]), false);
  assert.equal(await written([false, true]), true, "the window was covered when the benchmark wrote its value");
  assert.equal(await written([true, false]), true, "the window was covered at the start of the interval");
});

test("a benchmark that failed and cannot read its window keeps the conditions of its start, and its verdict is failed", { timeout: 5000 }, async (t) => {
  const configDir = folder(t);
  writeFileSync(policyFile(configDir), JSON.stringify({ schema: 1, classes: FRAME_DEBUG }));
  const settings = { "diagnostics.performance": false, "diagnostics.log": { frame: "debug" } };
  let gone = false;
  const s = {
    window: "w1", app: { configDir },
    get: async (name) => {
      if (name === "core.settings") return { values: settings };
      if (gone) throw new Error("the window is gone");
      return { refreshRate: 120, scale: 2, content: { width: 1200, height: 760 }, occluded: false, active: true };
    },
  };
  const path = join(folder(t), "out.json");
  await assert.rejects(withB3Out({ path, state: "0", keys: B3_MEASUREMENTS["view-drag"]["0"] }, async (run) => {
    run.conditions = await b3Conditions(s, settings);
    gone = true;
    throw new Error("the drag lost a frame");
  }), new Error("the drag lost a frame"));
  const output = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(output.measurements.verdict, "failed");
  assert.equal(output.conditions.occluded, false);
});

test("a benchmark records an application that lost its activation during the interval", { timeout: 5000 }, async (t) => {
  const configDir = folder(t);
  writeFileSync(policyFile(configDir), JSON.stringify({ schema: 1, classes: FRAME_DEBUG }));
  const settings = { "diagnostics.performance": false, "diagnostics.log": { frame: "debug" } };
  const written = async (readings) => {
    const s = {
      window: "w1", app: { configDir },
      get: async (name) => {
        if (name === "core.settings") return { values: settings };
        return { refreshRate: 120, scale: 2, content: { width: 1200, height: 760 }, occluded: false, active: readings.shift() };
      },
    };
    const path = join(folder(t), "out.json");
    await withB3Out({ path, state: null, keys: B3_MEASUREMENTS["idle-tab"] }, async (run) => {
      run.conditions = await b3Conditions(s, settings);
      run.measurements.idleTabCostKb = 1;
    });
    return JSON.parse(readFileSync(path, "utf8")).conditions.active;
  };
  assert.equal(await written([true, true]), true);
  assert.equal(await written([true, false]), false, "the activation ended before the benchmark wrote its value");
  assert.equal(await written([false, true]), false, "the application was not active at the start of the interval");
});

test("a benchmark that sets a copy of its conditions writes nothing, because a copy would record the window of its start", { timeout: 5000 }, async (t) => {
  const path = join(folder(t), "out.json");
  const target = { path, state: null, keys: B3_MEASUREMENTS["idle-tab"] };
  const copy = { ...(await started(t)) };
  await assert.rejects(withB3Out(target, async (run) => { run.conditions = copy; run.measurements.idleTabCostKb = 1; }),
    new Error(`the B3 conditions of a benchmark are the object that b3Conditions returned, which withB3Out reads again when it writes, not ${JSON.stringify(copy)}`));
  assert.throws(() => readFileSync(path), { code: "ENOENT" });
});

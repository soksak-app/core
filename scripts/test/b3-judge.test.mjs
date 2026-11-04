// The judge of the three-host benchmark (scripts/b3-judge.mjs, docs/operations/examples.md#three-host-benchmark): the bounds, the
// relative criteria, the regression rule, the comparisons of a value with another value of the mygo host and the run conditions of
// docs/spec/performance-goals.json, applied to the fixture session of scripts/test/fixtures/b3/ and to sessions written for the goals.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GOALS_FILE, judgeSession, readGoals, readSession } from "../b3-judge.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = join(ROOT, "scripts", "test", "fixtures", "b3");
const fixtureGoals = () => readGoals(readFileSync(join(FIXTURES, "goals.json"), "utf8"), "goals.json");
const fixtureSession = () => readSession(join(FIXTURES, "session"));
const failedLines = (result) => result.lines.filter((line) => line.startsWith("failed "));

/** Sets the reading `id` of the run `run` of `application` in the session to `measured`. */
function setReading(session, application, run, id, measured) {
  const record = session.records.find((entry) => entry.application === application && entry.run === run && Object.hasOwn(entry.values, id));
  assert.ok(record, `the fixture session has no reading ${id} of run ${run} of ${application}`);
  record.values[id] = measured;
}

function folder(t) {
  const path = mkdtempSync(join(tmpdir(), "soksak-b3-judge-test-"));
  t.after(() => rmSync(path, { recursive: true }));
  return path;
}

test("a session that meets every bound and criterion passes, and each value is printed with its runs, its median and its spread", { timeout: 1000 }, () => {
  const result = judgeSession(fixtureGoals(), fixtureSession());
  assert.deepEqual(failedLines(result), []);
  assert.equal(result.failures, 0);
  assert.ok(result.lines.includes("value G2-S0-host-cpu mygo: runs 0.05 0.06 0.07, median 0.06, spread 0.05..0.07"), result.lines.join("\n"));
  assert.ok(result.lines.includes("passed G2-S0-host-cpu mygo: median 0.06, at most 0.12 s"));
  assert.ok(result.lines.includes("passed G2-S0-host-cpu mygo against baseline-tauriv2: spread 0.05..0.07 against 0.06..0.08, not wholly above"));
  assert.ok(result.lines.includes("value G4-S5-view-drag mygo: runs passed passed passed"));
});

test("a recorded run of the mygo host outside a bound fails the value", { timeout: 1000 }, () => {
  const each = fixtureSession();
  setReading(each, "mygo", 2, "G2-S0-frames", 3);
  assert.deepEqual(failedLines(judgeSession(fixtureGoals(), each)), ["failed G2-S0-frames mygo: runs 0 3 0, equals 0"]);
  const below = fixtureSession();
  for (const run of [1, 2]) setReading(below, "mygo", run, "G3-S10-host-growth", 131072);
  assert.deepEqual(failedLines(judgeSession(fixtureGoals(), below)), ["failed G3-S10-host-growth mygo: median 131072, below 131072 KB"]);
  const other = fixtureSession();
  setReading(other, "wailsv3", 1, "G2-S0-frames", 3);
  assert.deepEqual(failedLines(judgeSession(fixtureGoals(), other)), [], "a bound applies to the values of the mygo host");
});

test("a failed benchmark verdict of the mygo host fails G4", { timeout: 1000 }, () => {
  const session = fixtureSession();
  setReading(session, "mygo", 3, "G4-S5-view-drag", "failed");
  assert.deepEqual(failedLines(judgeSession(fixtureGoals(), session)), ["failed G4-S5-view-drag mygo: runs passed passed failed, equals passed"]);
});

test("a spread of the mygo host wholly on the bounded side of the spread of an other or a baseline host fails, above for a time and below for a frame rate", { timeout: 1000 }, () => {
  const time = fixtureSession();
  for (const run of [1, 2, 3]) setReading(time, "mygo", run, "G2-S0-host-cpu", 0.081);
  assert.deepEqual(failedLines(judgeSession(fixtureGoals(), time)), [
    "failed G2-S0-host-cpu mygo against wailsv3: spread 0.081..0.081 against 0.06..0.08, wholly above",
    "failed G2-S0-host-cpu mygo against tauriv2: spread 0.081..0.081 against 0.06..0.08, wholly above",
    "failed G2-S0-host-cpu mygo against baseline-wailsv3: spread 0.081..0.081 against 0.06..0.08, wholly above",
    "failed G2-S0-host-cpu mygo against baseline-tauriv2: spread 0.081..0.081 against 0.06..0.08, wholly above",
  ]);
  const overlapping = fixtureSession();
  setReading(overlapping, "mygo", 1, "G2-S0-host-cpu", 0.08);
  for (const run of [2, 3]) setReading(overlapping, "mygo", run, "G2-S0-host-cpu", 0.11);
  assert.deepEqual(failedLines(judgeSession(fixtureGoals(), overlapping)), [], "a spread that touches the spread of the other host does not lie wholly above it");
  const rate = fixtureSession();
  for (const run of [1, 2, 3]) setReading(rate, "mygo", run, "G5-S2-rows-1-frame-rate", 29.1);
  assert.equal(failedLines(judgeSession(fixtureGoals(), rate)).length, 4);
  assert.match(failedLines(judgeSession(fixtureGoals(), rate))[0], /^failed G5-S2-rows-1-frame-rate mygo against wailsv3: spread 29\.1\.\.29\.1 against 29\.25\.\.29\.75, wholly below$/);
});

test("a spread of an other host wholly above the spread of its baseline host is a regression", { timeout: 1000 }, () => {
  const session = fixtureSession();
  for (const run of [1, 2, 3]) setReading(session, "tauriv2", run, "G2-S0-host-cpu", 0.09);
  assert.deepEqual(failedLines(judgeSession(fixtureGoals(), session)), [
    "failed G2-S0-host-cpu regression of tauriv2 against baseline-tauriv2: spread 0.09..0.09 against 0.06..0.08, wholly above",
  ]);
});

test("a value of the mygo host whose spread lies wholly above the spread of the value that it is compared with fails", { timeout: 1000 }, () => {
  const session = fixtureSession();
  for (const run of [1, 2, 3]) setReading(session, "mygo", run, "G3-S4-host-footprint", 70301);
  assert.deepEqual(failedLines(judgeSession(fixtureGoals(), session)), [
    "failed G3-S4-host-footprint mygo against G3-S1-host-footprint: spread 70301..70301 against 70100..70300, wholly above",
  ]);
});

test("a run outside the run conditions, a failed run, a missing run and an unknown reading fail the session", { timeout: 1000 }, () => {
  const session = fixtureSession();
  const record = (scenario, run, application) => session.records.find((entry) => entry.scenario === scenario && entry.run === run && entry.application === application);
  record("S0", 1, "mygo").display.refreshRate = 60;
  record("S0", 2, "mygo").display.backingScale = 1;
  record("S0", 3, "mygo").start.swap.usedBytes = 536870912;
  record("S1", 1, "mygo").start.fseventsdCores = 0.1;
  record("S1", 2, "wailsv3").failures.push("make app-usage STATE=S1 exited with code 1");
  record("S1", 3, "tauriv2").values["G2-S0-frames"] = 0;
  record("S5", 1, "mygo").conditions["make e2e-benchmark-view-drag TRACE=0"].refreshRate = 60;
  record("S5", 3, "mygo").conditions["make e2e-benchmark-view-drag TRACE=0"].window = { width: 760, height: 614 };
  record("S2", 1, "mygo").conditions["make terminal-redraw-usage PLUGIN=term RATE=30 ROWS=1"].window = { width: 1200, height: 760 };
  delete record("S5", 2, "mygo").conditions;
  session.records.splice(session.records.indexOf(record("S10", 3, "mygo")), 1);
  assert.deepEqual(failedLines(judgeSession(fixtureGoals(), session)), [
    "failed run 1 of mygo in S0: the display mode runs at 60 Hz, expected 120 Hz",
    "failed run 2 of mygo in S0: the backing scale of the window is 1, expected 2",
    "failed run 3 of mygo in S0: swap use 536870912 B is not below 0.5 of the swap total 1073741824 B",
    "failed run 1 of mygo in S1: fseventsd uses 0.1 of a core, not below 0.1",
    "failed run 2 of wailsv3 in S1: make app-usage STATE=S1 exited with code 1",
    "failed run 3 of tauriv2 in S1: it records G2-S0-frames, which is no value of S1",
    "failed run 1 of mygo in S5: make e2e-benchmark-view-drag TRACE=0: the display mode runs at 60 Hz, expected 120 Hz",
    "failed run 2 of mygo in S5: the run records no conditions of its targets (undefined)",
    "failed run 3 of mygo in S5: make e2e-benchmark-view-drag TRACE=0: the window is 760×614 points, expected 1200×760 points",
    "failed run 1 of mygo in S2: make terminal-redraw-usage PLUGIN=term RATE=30 ROWS=1: the window is 1200×760 points, expected 760×614 points",
    "failed G3-S10-host-growth mygo: the session records 2 of its 3 runs",
  ]);
  const short = fixtureSession();
  short.runs = 2;
  assert.ok(failedLines(judgeSession(fixtureGoals(), short)).includes("failed session: it holds 2 runs of each application, the goals require 3"));
});

test("the session names the mygo host, the two other hosts and their baseline hosts", { timeout: 1000 }, () => {
  const session = fixtureSession();
  session.applications = session.applications.filter((entry) => entry.name !== "baseline-wailsv3");
  assert.throws(() => judgeSession(fixtureGoals(), session), /^Error: session\.json: holds the applications .* expected the mygo host, the Wails and the Tauri host of the build current and the Wails and the Tauri host of the build baseline$/);
});

test("the goals are rejected when they do not hold the format that the judge applies", { timeout: 1000 }, () => {
  const text = readFileSync(join(FIXTURES, "goals.json"), "utf8");
  const changed = (change) => {
    const goals = JSON.parse(text);
    change(goals);
    return JSON.stringify(goals);
  };
  assert.throws(() => readGoals(changed((goals) => { goals.values[0].bound = { atMost: 1, atLeast: 0 }; }), "goals.json"), /value "G2-S0-frames": has the bound/);
  assert.throws(() => readGoals(changed((goals) => { goals.values[0].relative = true; }), "goals.json"), /value "G2-S0-frames": compares a value of the unit count, which has no bounded side/);
  assert.throws(() => readGoals(changed((goals) => { goals.values[3].against = "G3-S1-missing"; }), "goals.json"), /is compared with G3-S1-missing, which the file does not hold/);
  assert.throws(() => readGoals(changed((goals) => { goals.values[1].id = "G2-S1-host-cpu"; }), "goals.json"), /does not start with its goal and scenario G2-S0-/);
  assert.throws(() => readGoals(changed((goals) => { delete goals.conditions.backingScale; }), "goals.json"), /holds the conditions/);
  assert.throws(() => readGoals(changed((goals) => { goals.conditions.window = { width: 1200 }; }), "goals.json"), /holds the condition window \{"width":1200\}, expected \{width, height\} of positive numbers/);
  assert.throws(() => readGoals(changed((goals) => { goals.conditions.scenarioWindows = { S99: { width: 1, height: 1 } }; }), "goals.json"), /holds a window of S99, which no value names/);
  assert.throws(() => readGoals(changed((goals) => { goals.values[5].bound = { equals: 0 }; }), "goals.json"), /does not fit the unit verdict/);
  assert.throws(() => readGoals(changed((goals) => { delete goals.values[2].measurement; }), "goals.json"), /value "G3-S1-host-footprint": names the measurement undefined, expected a camelCase key of the output of its target/);
  assert.equal(readGoals(readFileSync(GOALS_FILE, "utf8"), "docs/spec/performance-goals.json").values.length > 0, true);
});

/** A session of the five applications whose runs meet every bound of `goals` with the same readings on every application. */
function sessionMeeting(goals, path) {
  const applications = [["mygo", "mygo", "current"], ["wailsv3", "wailsv3", "current"], ["tauriv2", "tauriv2", "current"],
    ["baseline-wailsv3", "wailsv3", "baseline"], ["baseline-tauriv2", "tauriv2", "baseline"]].map(([name, host, build]) => ({ name, host, build }));
  writeFileSync(join(path, "session.json"), JSON.stringify({ schema: 1, phase: "final", runs: goals.runs, applications }));
  const reading = (value) => {
    if (value.unit === "verdict") return "passed";
    const [[kind, limit]] = Object.entries(value.bound ?? { none: 100 });
    return { equals: limit, atMost: limit / 2, atLeast: limit * 2, below: limit / 2, none: limit }[kind];
  };
  const lines = [];
  for (const scenario of new Set(goals.values.map((value) => value.scenario))) {
    for (let run = 1; run <= goals.runs; run += 1) {
      for (const { name } of applications) {
        const values = Object.fromEntries(goals.values.filter((value) => value.scenario === scenario).map((value) => [value.id, reading(value)]));
        lines.push(JSON.stringify({
          scenario, run, application: name, values, failures: [],
          start: { loadAverage: [1, 1, 1], swap: { usedBytes: 0, totalBytes: 1 << 30 }, fseventsdCores: 0 },
          display: { refreshRate: goals.conditions.refreshRate, backingScale: goals.conditions.backingScale }, end: { loadAverage: [1, 1, 1] },
          conditions: Object.fromEntries(goals.values.filter((value) => value.scenario === scenario).map((value) => [value.target, {
            refreshRate: goals.conditions.refreshRate, backingScale: goals.conditions.backingScale, traceState: false, logPolicy: { lifecycle: "error", input: "error", call: "error", io: "error", frame: "error" },
            window: goals.conditions.scenarioWindows[scenario] ?? goals.conditions.window,
          }])),
        }));
      }
    }
  }
  writeFileSync(join(path, "runs.jsonl"), `${lines.join("\n")}\n`);
  return lines;
}

test("make b3-judge judges a session folder against docs/spec/performance-goals.json and exits with status 1 when a value fails", { timeout: 20000 }, (t) => {
  const goals = readGoals(readFileSync(GOALS_FILE, "utf8"), "docs/spec/performance-goals.json");
  const path = folder(t);
  const lines = sessionMeeting(goals, path);
  const judge = () => spawnSync("make", ["-s", "--no-print-directory", "b3-judge", `SESSION=${path}`], { cwd: ROOT, encoding: "utf8" });
  const passed = judge();
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, new RegExp(`^passed session ${path}: 0 failures$`, "m"));
  for (const value of goals.values) assert.match(passed.stdout, new RegExp(`^value ${value.id} mygo: runs `, "m"), `${value.id} is not printed`);
  const records = lines.map((line) => JSON.parse(line));
  const hitTests = records.filter((entry) => entry.application === "mygo" && Object.hasOwn(entry.values, "G8-S1-hit-test-p90"));
  for (const entry of hitTests.slice(0, Math.ceil(goals.runs / 2))) entry.values["G8-S1-hit-test-p90"] = 8.34;
  const verdict = records.find((entry) => entry.application === "mygo" && Object.hasOwn(entry.values, "G4-S7-term-view"));
  verdict.values["G4-S7-term-view"] = "failed";
  writeFileSync(join(path, "runs.jsonl"), `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const failed = judge();
  assert.equal(failed.status, 2, `make reports the exit status 1 of the judge as 2: ${failed.stdout}${failed.stderr}`);
  assert.match(failed.stdout, /^failed G8-S1-hit-test-p90 mygo: median 8\.34, at most 8\.33 ms$/m);
  assert.match(failed.stdout, /^failed G4-S7-term-view mygo: runs (passed )*failed( passed)*, equals passed$/m);
  assert.match(failed.stdout, new RegExp(`^failed session ${path}: 2 failures$`, "m"));
});

// The run of the three-host benchmark (scripts/benchmark-b3.mjs, docs/operations/examples.md#three-host-benchmark): the checks of the
// baseline checkout, of the sidecar revision record and of the plugins of the baseline hosts against the baseline record, the run
// conditions from injected readings, the interleaved order of the five applications, the commands of the targets, the steps of runPlan
// for each run of fixture applications, and the session folder that make check-b3 reads.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { connect } from "@soksak/client";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { policyOfSetting } from "@soksak/window-check/log-policy.mjs";
import { judgeSession, readGoals, readSession } from "../b3-judge.mjs";
import {
  appendRecord, baselineRecordFile, buildSteps, applicationsOf, attributionUnits, baselineCheckoutFailures, baselinePluginFailures, createSession, fseventsdCores, installedReleases, parseSwapUsage,
  readBaselineRecord, readCheckout, readSidecarRevisions, readTargetOutput, runUnit, scenarioTargets, sessionUnits, sidecarRevisionFailures,
  surfacePlugins, targetCommand, traceStateOf, unitPlan,
} from "../benchmark-b3.mjs";
import { traceSettings } from "../measure-trace.mjs";
import { B3_MEASUREMENTS, B3_SETTINGS } from "../../e2e/benchmark/measurements.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = join(ROOT, "scripts", "test", "fixtures", "b3");
const hex = (digit, length = 40) => digit.repeat(length);
const baselineRecord = () => readBaselineRecord(readFileSync(join(FIXTURES, "baseline.json"), "utf8"), "baseline.json");
const fixtureGoals = () => readGoals(readFileSync(join(FIXTURES, "goals.json"), "utf8"), "goals.json");

function folder(t) {
  const path = mkdtempSync(join(tmpdir(), "soksak-e2e-b3-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

test("a BASELINE checkout whose head differs from the last head of the baseline record or whose working tree holds changes fails before the first run", { timeout: 10000 }, (t) => {
  const checkout = folder(t);
  git(checkout, "init", "--quiet");
  writeFileSync(join(checkout, "file.txt"), "one\n");
  git(checkout, "add", "file.txt");
  git(checkout, "commit", "--quiet", "-m", "one");
  const head = git(checkout, "rev-parse", "HEAD");
  const record = { ...baselineRecord(), heads: [hex("1"), head] };
  assert.deepEqual(baselineCheckoutFailures(record, readCheckout(checkout), checkout), []);
  writeFileSync(join(checkout, "file.txt"), "two\n");
  assert.deepEqual(baselineCheckoutFailures(record, readCheckout(checkout), checkout), [`the working tree of ${checkout} holds changes outside its head ${head}: M file.txt`]);
  git(checkout, "commit", "--quiet", "-am", "two");
  const next = git(checkout, "rev-parse", "HEAD");
  assert.deepEqual(baselineCheckoutFailures(record, readCheckout(checkout), checkout), [`the head ${next} of ${checkout} differs from the last head ${head} of the baseline record`]);
  writeFileSync(join(checkout, "new.txt"), "new\n");
  assert.equal(baselineCheckoutFailures({ ...record, heads: [next] }, readCheckout(checkout), checkout).length, 1, "an untracked file is a change outside the head");
});

test("a sidecar revision of the registry record that differs from the last revision of the baseline record, or a working tree with changes, fails", { timeout: 1000 }, () => {
  const record = baselineRecord();
  const revisions = readSidecarRevisions(readFileSync(join(FIXTURES, "sidecar-revisions.json"), "utf8"), "target/registry/sidecar-revisions.json");
  assert.deepEqual(sidecarRevisionFailures(record, revisions), []);
  const older = { sidecars: revisions.sidecars.map((entry) => (entry.repository === "../sidecars/alacritty" ? { ...entry, revision: hex("a") } : entry)) };
  assert.deepEqual(sidecarRevisionFailures(record, older), [`the registry built ../sidecars/alacritty at ${hex("a")}, which differs from the last revision ${hex("b")} of the baseline record`]);
  const changed = { sidecars: revisions.sidecars.map((entry) => (entry.repository === "../sidecars/files" ? { ...entry, changes: true } : entry)) };
  assert.deepEqual(sidecarRevisionFailures(record, changed), [`the working tree of ../sidecars/files held changes outside ${hex("c")} when the registry built it`]);
  const unknown = { sidecars: [...revisions.sidecars, { repository: "../sidecars/vt", revision: hex("f"), changes: false }] };
  assert.deepEqual(sidecarRevisionFailures(record, unknown), ["the registry built ../sidecars/vt, for which the baseline record holds no revision"]);
  const missing = { sidecars: revisions.sidecars.slice(1) };
  assert.deepEqual(sidecarRevisionFailures(record, missing), ["the registry built no revision of ../sidecars/alacritty, which the baseline record holds"]);
  assert.throws(() => readSidecarRevisions(JSON.stringify({ sidecars: [{ repository: "../sidecars/vt", revision: "abc", changes: false }] }), "record.json"),
    /^Error: record\.json: sidecar \.\.\/sidecars\/vt has the revision "abc", expected 40 hexadecimal digits$/);
});

test("the installed plugins of a baseline host that differ in version or sha256 from the baseline record fail the run", { timeout: 1000 }, () => {
  const index = {
    plugins: [
      { id: "browser", versions: [{ version: "0.0.15", release: { url: "file:///b.tgz", sha256: hex("d", 64) } }] },
      { id: "term", versions: [{ version: "0.0.3", release: { url: "file:///t3.tgz", sha256: hex("e", 64) } }, { version: "0.0.4", release: { url: "file:///t4.tgz", sha256: hex("9", 64) } }] },
    ],
    sidecars: [{ name: "fixture-sidecar", versions: [{ version: "0.0.20", protocol: 1, releases: { "darwin-arm64": { url: "file:///sidecar.tgz", sha256: hex("8", 64) } } }] }],
  };
  const installed = {
    format: 3,
    plugins: { browser: { version: "0.0.15", path: "plugins/browser/0.0.15", enabled: true, sidecars: {} }, term: { version: "0.0.3", path: "plugins/term/0.0.3", enabled: true, sidecars: {} } },
    sidecars: { "fixture-sidecar": { version: "0.0.20", path: "sidecars/fixture-sidecar/0.0.20/darwin-arm64" } },
  };
  const releases = installedReleases(installed, index, "darwin-arm64");
  assert.deepEqual(releases, [
    { kind: "plugin", id: "browser", version: "0.0.15", sha256: hex("d", 64) },
    { kind: "plugin", id: "term", version: "0.0.3", sha256: hex("e", 64) },
    { kind: "sidecar", id: "fixture-sidecar", version: "0.0.20", sha256: hex("8", 64) },
  ]);
  assert.deepEqual(baselinePluginFailures(baselineRecord(), releases), []);
  installed.plugins.term.version = "0.0.4";
  assert.deepEqual(baselinePluginFailures(baselineRecord(), installedReleases(installed, index, "darwin-arm64")),
    [`the baseline host installed term 0.0.4 ${hex("9", 64)}, the baseline record holds term 0.0.3 ${hex("e", 64)}`]);
  delete installed.plugins.browser;
  installed.plugins.term.version = "0.0.3";
  assert.deepEqual(baselinePluginFailures(baselineRecord(), installedReleases(installed, index, "darwin-arm64")), ["the baseline host installed no release of browser, which the baseline record holds"]);
  assert.deepEqual(installedReleases(null, index, "darwin-arm64"), [], "a configuration folder without plugins/installed.json has nothing installed");
  installed.plugins.term.version = "0.0.9";
  assert.throws(() => installedReleases(installed, index, "darwin-arm64"), /^Error: the index lists no release of term 0\.0\.9$/);
});

test("the surface plugins are the installed plugins whose manifest declares a surface", { timeout: 1000 }, () => {
  const installed = { format: 3, plugins: { files: { version: "1", path: "plugins/files/1" }, term: { version: "2", path: "plugins/term/2" } }, sidecars: {} };
  const manifests = { "plugins/files/1": { id: "files", sidebars: {} }, "plugins/term/2": { id: "term", surface: { composition: { kind: "view", page: "index.html" } } } };
  assert.deepEqual(surfacePlugins(installed, (path) => manifests[path]), ["term"]);
});

test("the run conditions are read from injected readings of swap use, of fseventsd and of the display", { timeout: 1000 }, () => {
  assert.deepEqual(parseSwapUsage("total = 2048.00M  used = 1023.25M  free = 1024.75M  (encrypted)\n"), { usedBytes: 1023.25 * 1048576, totalBytes: 2048 * 1048576 });
  assert.deepEqual(parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)\n"), { usedBytes: 0, totalBytes: 0 });
  assert.throws(() => parseSwapUsage("vm.swapusage: unknown"), /^Error: sysctl vm\.swapusage printed "vm\.swapusage: unknown", which names no total and no used size$/);
  const before = "  1 0:10.00 /sbin/launchd\n 88 1:00.00 /usr/sbin/fseventsd\n";
  const after = "  1 0:10.50 /sbin/launchd\n 88 1:00.40 /usr/sbin/fseventsd\n";
  assert.equal(fseventsdCores(before, after, 5), 0.08);
  assert.throws(() => fseventsdCores(" 1 0:10.00 /sbin/launchd\n", after, 5), /^Error: the process list holds no fseventsd process$/);
});

test("a swap total of zero leaves no swap in use, so the run may start", { timeout: 1000 }, async () => {
  const { startConditionFailures } = await import("../b3-judge.mjs");
  const goals = fixtureGoals();
  assert.deepEqual(startConditionFailures(goals, { loadAverage: [1, 1, 1], swap: { usedBytes: 0, totalBytes: 0 }, fseventsdCores: 0 }), []);
  assert.deepEqual(startConditionFailures(goals, { loadAverage: [1, 1, 1], swap: { usedBytes: 6, totalBytes: 10 }, fseventsdCores: 0.2 }),
    ["swap use 6 B is not below 0.5 of the swap total 10 B", "fseventsd uses 0.2 of a core, not below 0.1"]);
});

test("the runs interleave the five applications, run S0b in the application that S3 leaves, and run a scenario without a relative value only on the mygo host", { timeout: 1000 }, () => {
  const goals = readGoals(readFileSync(join(ROOT, "docs", "spec", "performance-goals.json"), "utf8"), "docs/spec/performance-goals.json");
  const applications = applicationsOf({ root: "/core", baseline: "/baseline" });
  assert.deepEqual(applications.map((entry) => entry.name), ["mygo", "wailsv3", "tauriv2", "baseline-wailsv3", "baseline-tauriv2"]);
  const units = sessionUnits(goals, 2, applications);
  const order = units.map((unit) => `${unit.scenarios.join("+")} ${unit.run} ${unit.application.name}`);
  assert.deepEqual(order.slice(0, 10), [
    "S0 1 mygo", "S0 1 wailsv3", "S0 1 tauriv2", "S0 1 baseline-wailsv3", "S0 1 baseline-tauriv2",
    "S0 2 mygo", "S0 2 wailsv3", "S0 2 tauriv2", "S0 2 baseline-wailsv3", "S0 2 baseline-tauriv2",
  ]);
  assert.ok(order.includes("S3+S0b 1 baseline-tauriv2"), "S3 runs on every application because S0b compares its footprint");
  assert.ok(!order.some((entry) => entry.startsWith("S0b ")), "S0b runs in the application that S3 leaves");
  for (const scenario of ["S4", "S7", "S10", "S16"]) {
    assert.deepEqual(order.filter((entry) => entry.startsWith(`${scenario} `)), [`${scenario} 1 mygo`, `${scenario} 2 mygo`], `${scenario} compares no value with another host`);
  }
  const scenarios = [...new Set(units.map((unit) => unit.scenarios.join("+")))];
  assert.deepEqual(scenarios, ["S0", "S1", "S2", "S3+S0b", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13", "S14", "S15", "S16"]);
});

test("the targets of a scenario come from the goals in their order, and STEP=pointer runs after every other reading of the scenario", { timeout: 1000 }, () => {
  const goals = readGoals(readFileSync(join(ROOT, "docs", "spec", "performance-goals.json"), "utf8"), "docs/spec/performance-goals.json");
  assert.deepEqual(scenarioTargets(goals, "S1"), ["make measure-app-usage STATE=S1 IDLE=1 INTERVAL=240", "make measure-app-usage STATE=S1",
    "make measure-app-usage STATE=S1 STEP=pointer", "make measure-app-usage STATE=S1 STEP=pointer TRACE=frame-records"], "the pointer step runs once in each trace state of its output");
  assert.deepEqual(scenarioTargets(goals, "S0"), ["make measure-app-usage STATE=S0", "make measure-app-usage STATE=S0 IDLE=1 INTERVAL=240", "make measure-app-usage STATE=S0 STEP=pointer"]);
  assert.deepEqual(scenarioTargets(goals, "S5"), ["make benchmark-view-drag TRACE=0", "make benchmark-resize-catch-up TRACE=captured",
    "make benchmark-view-drag TRACE=frame-records", "make benchmark-resize-catch-up TRACE=frame-records"], "a benchmark that measures in two trace states runs once in each");
});

test("phase 1 reruns with TRACE=1 each target that takes the trace state of the run, and no target that names its own TRACE", { timeout: 1000 }, () => {
  const goals = readGoals(readFileSync(join(ROOT, "docs", "spec", "performance-goals.json"), "utf8"), "docs/spec/performance-goals.json");
  const [mygo] = applicationsOf({ root: "/core", baseline: "/baseline" });
  const [debug] = applicationsOf({ root: "/core", baseline: "/baseline" }, "debug");
  const targets = Object.fromEntries(attributionUnits(goals, [mygo], [debug])
    .flatMap((unit) => unit.scenarios.map((scenario) => [scenario, unit.targets(scenario)])));
  assert.deepEqual(targets.S1, ["make measure-app-usage STATE=S1 IDLE=1 INTERVAL=240", "make measure-app-usage STATE=S1", "make measure-app-usage STATE=S1 STEP=pointer"],
    "the pointer CPU and footprints rerun with TRACE=1, and the hit-test target of the frame records measures in its own state");
  assert.deepEqual(targets.S0, ["make measure-app-usage STATE=S0", "make measure-app-usage STATE=S0 IDLE=1 INTERVAL=240", "make measure-app-usage STATE=S0 STEP=pointer"]);
  assert.ok(!Object.hasOwn(targets, "S5"), "the benchmarks of S5 take no TRACE of the run");
  assert.deepEqual(targets.debug, ["make measure-trace-share"]);
});

test("a target runs in the checkout of its application with its configuration folder, its sok, its trace state and its value file", { timeout: 1000 }, () => {
  const [, , , baseline] = applicationsOf({ root: "/core", baseline: "/baseline" });
  const paths = { configRoot: "/core/target/b3/s/configs/S1-1-baseline-wailsv3", configDir: "/core/target/b3/s/configs/S1-1-baseline-wailsv3/soksak-check-wailsv3",
    trace: 0, out: "/core/target/b3/s/outputs/S1/1-baseline-wailsv3/1.json", plugins: ["browser", "term"], runId: "b3-S1-1-baseline-wailsv3", runFolder: "/core/target/b3/s/outputs/S1/1-baseline-wailsv3" };
  const make = targetCommand("make measure-app-usage STATE=S1 STEP=pointer", { application: baseline, ...paths });
  assert.deepEqual(make.argv, ["make", "-s", "--no-print-directory", "measure-app-usage", "STATE=S1", "STEP=pointer", "APP=wailsv3", `CONFIG=${paths.configDir}`,
    `CONFIG_DIR=${paths.configDir}`, "SOK=/baseline/target/release/wailsv3/soksak.app/Contents/MacOS/sok", "TRACE=0", "PLUGINS=browser term", `B3_OUT=${paths.out}`]);
  assert.equal(make.cwd, "/baseline");
  assert.equal(make.env.SOKSAK_APP, "wailsv3");
  assert.equal(make.env.SOKSAK_CONFIG_ROOT, paths.configRoot);
  assert.equal(make.env.SOKSAK_BINARY_WAILSV3, "/baseline/target/release/wailsv3/soksak.app/Contents/MacOS/soksak-wailsv3");
  assert.equal(make.env.SOKSAK_B3_OUT, undefined, "a make target takes B3_OUT as a variable");
  const frameRecords = targetCommand("make benchmark-view-drag TRACE=frame-records", { application: baseline, ...paths });
  assert.deepEqual(frameRecords.argv.filter((word) => word.startsWith("TRACE=")), ["TRACE=frame-records"], "the TRACE argument of the entry is the trace state of the target");
  assert.deepEqual(targetCommand("make benchmark-split-load", { application: baseline, ...paths }).argv.filter((word) => word.startsWith("TRACE=")), [],
    "a benchmark applies the settings that B3_SETTINGS declares for it and takes no TRACE of the run");
  assert.equal(make.env.SOKSAK_RUN_ID, paths.runId);
  const check = targetCommand("e2e/benchmark/term-view.test.mjs", { application: baseline, ...paths });
  assert.deepEqual(check.argv, ["pnpm", "-F", "@soksak/e2e", "exec", "node", "./run.mjs", "--test", "--test-concurrency=1", "--test-global-setup=./setup.mjs", "benchmark/term-view.test.mjs"]);
  assert.equal(check.cwd, "/baseline");
  assert.equal(check.env.SOKSAK_B3_OUT, paths.out, "a check of e2e/ reads the path of its output from SOKSAK_B3_OUT");
  assert.throws(() => targetCommand("node elsewhere.mjs", { application: baseline, ...paths }), /^Error: the target "node elsewhere\.mjs" is neither a make target nor a check of e2e\/$/);
});

test("a run installs the index of its application into a new configuration folder under target/b3 and starts the executable of its release bundle", { timeout: 1000 }, () => {
  const [mygo, , , baseline] = applicationsOf({ root: "/core", baseline: "/baseline" });
  assert.equal(mygo.executable, "/core/target/release/mygo/soksak.app/Contents/MacOS/sok-mygo");
  assert.equal(mygo.index, "/core/target/registry/index.json");
  assert.equal(baseline.index, "/core/target/registry-public/index.json");
  const configRoot = "/core/target/b3/s/configs/S0-1-baseline-wailsv3";
  const configDir = `${configRoot}/soksak-check-wailsv3`;
  const plan = unitPlan({ application: baseline, configRoot, configDir, pluginIds: ["browser", "term"] });
  assert.deepEqual(plan.prepare.map((step) => [step.phase, step.kind, step.argv]), [
    ["prepare", "run", [baseline.sok, "registry", "use", "/core/target/registry-public/index.json", "--config-dir", configDir]],
    ["prepare", "run", [baseline.sok, "plugin", "install", "browser", "--config-dir", configDir]],
    ["prepare", "run", [baseline.sok, "plugin", "install", "term", "--config-dir", configDir]],
    ["prepare", "start", ["/baseline/target/release/wailsv3/soksak.app/Contents/MacOS/soksak-wailsv3", "--config-dir", configDir]],
  ]);
  assert.equal(plan.prepare[3].app, "baseline-wailsv3");
  assert.deepEqual(plan.cleanup.map((step) => [step.phase, step.kind, step.app ?? step.paths]), [
    ["cleanup", "quit", "baseline-wailsv3"],
    ["cleanup", "remaining", [configRoot, "/baseline/target/release/wailsv3/soksak.app"]],
  ]);
});

/** The policy classes that the settings of the trace state `state` put in force. */
const policyOf = (state) => policyOfSetting(traceSettings(state)["diagnostics.log"]).classes;

/** The conditions that a target reports for a run on the display and the window of the run conditions in the trace state `state`. */
const targetConditions = (state = 0) => ({
  refreshRate: 120, backingScale: 2, traceState: traceSettings(state)["diagnostics.performance"], logPolicy: policyOf(state), window: { width: 1200, height: 760 }, occluded: false, active: true,
});

/**
 * The declarations of the e2e benchmarks in the form of e2e/benchmark/measurements.mjs: B3_MEASUREMENTS (`measurements`), a list of
 * keys for a benchmark that measures in one state and an object of states for a benchmark that measures in several, and B3_SETTINGS
 * (`settings`), the settings of the measured interval: one settings object for a list of keys, and the same states for an object.
 */
const BENCHMARKS = {
  measurements: {
    "view-drag": { 0: ["verdict", "dragCpuSeconds"], "frame-records": ["dragFrameP90Ms"] },
    "resize-catch-up": { captured: ["verdict"], "frame-records": ["maximiseFrameP90Ms"] },
    "split-load": ["hostGrowthKb"],
    "term-view": ["verdict"],
    "hwp-view": ["verdict"],
  },
  settings: {
    "view-drag": { 0: traceSettings(0), "frame-records": traceSettings("frame-records") },
    "resize-catch-up": {
      captured: { "diagnostics.performance": true, "diagnostics.log": { lifecycle: "debug", call: "debug", frame: "debug" } },
      "frame-records": traceSettings("frame-records"),
    },
    "split-load": { "diagnostics.performance": false, "diagnostics.log": { call: "debug" } },
    "term-view": { "diagnostics.performance": false, "diagnostics.log": {} },
  },
};

/** The conditions that an e2e benchmark reports on the display and the window of the run conditions under the settings `settings`. */
const settingsConditions = (settings) => ({
  refreshRate: 120, backingScale: 2, traceState: settings["diagnostics.performance"], logPolicy: policyOfSetting(settings["diagnostics.log"]).classes,
  window: { width: 1200, height: 760 }, occluded: false, active: true,
});

/** Writes `output` (an object, or text as it is) into a new file of a temporary folder and returns the path of the file. */
function outputFile(t, output) {
  const file = join(folder(t), "1.json");
  writeFileSync(file, typeof output === "string" ? output : JSON.stringify(output));
  return file;
}

test("a target writes its measurements under its own keys, and the run records each that an entry names under the id of the entry", { timeout: 1000 }, (t) => {
  const goals = fixtureGoals();
  const target = "make measure-app-usage STATE=S0 IDLE=1 INTERVAL=240";
  const read = (measurements, host) => readTargetOutput(outputFile(t, { measurements, conditions: targetConditions() }),
    { goals, scenario: "S0", target, application: { host }, trace: 0, code: 0, benchmarks: BENCHMARKS });
  assert.deepEqual(read({ frames: 0, hostCpuSeconds: 0.05, commandBuffers: 0 }, "mygo"),
    { values: { "G2-S0-frames": 0, "G2-S0-host-cpu": 0.05 }, conditions: targetConditions(), failures: [] }, "a measurement that no entry names is not recorded");
  assert.deepEqual(read({ hostCpuSeconds: 0.05 }, "wailsv3").failures, [], "an other host writes the measurements that are compared with other hosts");
  assert.deepEqual(read({ hostCpuSeconds: 0.05 }, "mygo").failures, ["G2-S0-frames: make measure-app-usage STATE=S0 IDLE=1 INTERVAL=240 wrote no measurement frames"]);
  assert.deepEqual(read({ frames: "passed", hostCpuSeconds: 0.05 }, "mygo").failures,
    ['G2-S0-frames: make measure-app-usage STATE=S0 IDLE=1 INTERVAL=240 wrote the measurement frames as "passed", expected a number']);
  const run = (file, code = 0) => readTargetOutput(file, { goals, scenario: "S0", target, application: { host: "mygo" }, trace: 0, code, benchmarks: BENCHMARKS }).failures;
  const notJson = outputFile(t, "{");
  assert.deepEqual(run(notJson).map((failure) => failure.split(":").slice(0, 2).join(":")), [`${notJson}: not JSON`], "readB3Out of scripts/b3-out.mjs reads the output");
  const form = outputFile(t, { values: {} });
  assert.deepEqual(run(form), [`${form}: the B3 output must have the members measurements and conditions, not values`]);
  const missing = join(folder(t), "1.json");
  assert.deepEqual(run(missing), [`make measure-app-usage STATE=S0 IDLE=1 INTERVAL=240 wrote no output ${missing}`]);
  assert.deepEqual(run(missing, 2), ["make measure-app-usage STATE=S0 IDLE=1 INTERVAL=240 exited with code 2"], "a target with an error writes no output");
});

test("a target reports the conditions of its measurement, and a display, a window or a trace state other than the run gave fails the run", { timeout: 1000 }, (t) => {
  const goals = fixtureGoals();
  const read = (target, conditions, trace = 0) => readTargetOutput(outputFile(t, { measurements: { frames: 0, hostCpuSeconds: 0.05, hostFootprintKb: 1 }, conditions }),
    { goals, scenario: target.includes("S1") ? "S1" : "S0", target, application: { host: "mygo" }, trace, code: 0, benchmarks: BENCHMARKS }).failures;
  const idle = "make measure-app-usage STATE=S0 IDLE=1 INTERVAL=240";
  assert.deepEqual(read(idle, { ...targetConditions(), refreshRate: 60 }), [`${idle}: the display mode runs at 60 Hz, expected 120 Hz`]);
  assert.deepEqual(read(idle, { ...targetConditions(), backingScale: 1 }), [`${idle}: the backing scale of the window is 1, expected 2`]);
  assert.deepEqual(read(idle, targetConditions(1)), [`${idle}: reports traceState true, expected false of TRACE=0`,
    `${idle}: reports logPolicy ${JSON.stringify(policyOf(1))}, expected ${JSON.stringify(policyOf(0))} of TRACE=0`]);
  assert.deepEqual(read(idle, targetConditions(1), 1), []);
  assert.deepEqual(read("make measure-app-usage STATE=S1", targetConditions("frame-records")),
    [`make measure-app-usage STATE=S1: reports logPolicy ${JSON.stringify(policyOf("frame-records"))}, expected ${JSON.stringify(policyOf(0))} of TRACE=0`]);
  const frameRecords = "make benchmark-view-drag TRACE=frame-records";
  assert.deepEqual(readTargetOutput(outputFile(t, { measurements: { dragFrameP90Ms: 5 }, conditions: targetConditions("frame-records") }),
    { goals, scenario: "S5", target: frameRecords, application: { host: "mygo" }, trace: 0, code: 0, benchmarks: BENCHMARKS }).failures, [], "the TRACE argument of the entry is the trace state of its run");
  assert.deepEqual(readTargetOutput(outputFile(t, { measurements: { dragFrameP90Ms: 5 }, conditions: targetConditions(0) }),
    { goals, scenario: "S5", target: frameRecords, application: { host: "mygo" }, trace: 0, code: 0, benchmarks: BENCHMARKS }).failures,
  [`${frameRecords}: reports logPolicy ${JSON.stringify(policyOf(0))}, expected ${JSON.stringify(policyOf("frame-records"))} of view-drag in the state frame-records`]);
  assert.equal(traceStateOf("make measure-app-usage STATE=S1 STEP=pointer", 0), 0);
  assert.equal(traceStateOf("make benchmark-split-load", 0), null);
  assert.equal(traceStateOf("make benchmark-resize-catch-up TRACE=captured", 0), "captured", "the TRACE of a benchmark names a state of its declarations");
  assert.throws(() => traceStateOf("make measure-app-usage STATE=S1 TRACE=2", 0), /^Error: make measure-app-usage STATE=S1 TRACE=2 names TRACE=2, expected 0, 1 or frame-records$/);
  assert.match(read(idle, { ...targetConditions(), window: { width: 0, height: 760 } })[0], /: B3 condition window must be \{width, height\} of positive numbers/);
  assert.deepEqual(read(idle, { ...targetConditions(), window: { width: 760, height: 614 } }), [`${idle}: the window is 760×614 points, expected 1200×760 points`]);
});

test("an e2e benchmark reports the settings that B3_SETTINGS declares for it in the state that its TRACE names, and other settings fail the run", { timeout: 1000 }, (t) => {
  const goals = fixtureGoals();
  const read = (target, conditions, scenario = "S5") => readTargetOutput(outputFile(t, { measurements: { verdict: "passed" }, conditions }),
    { goals, scenario, target, application: { host: "wailsv3" }, trace: 0, code: 0, benchmarks: BENCHMARKS }).failures;
  const split = "make benchmark-split-load";
  const captured = "make benchmark-resize-catch-up TRACE=captured";
  const term = "e2e/benchmark/term-view.test.mjs";
  const capturedSettings = BENCHMARKS.settings["resize-catch-up"].captured;
  assert.deepEqual(read(split, settingsConditions(BENCHMARKS.settings["split-load"]), "S10"), []);
  assert.deepEqual(read(captured, settingsConditions(capturedSettings)), []);
  assert.deepEqual(read(term, settingsConditions(BENCHMARKS.settings["term-view"]), "S7"), []);
  assert.deepEqual(read(split, targetConditions(0), "S10"), [
    `${split}: reports logPolicy ${JSON.stringify(policyOf(0))}, expected ${JSON.stringify(policyOfSetting({ call: "debug" }).classes)} of split-load`,
  ], "a benchmark without TRACE is compared with the settings of its one state");
  assert.deepEqual(read(term, targetConditions(1), "S7"), [
    `${term}: reports traceState true, expected false of term-view`,
    `${term}: reports logPolicy ${JSON.stringify(policyOf(1))}, expected ${JSON.stringify(policyOf(0))} of term-view`,
  ], "a check of e2e/ is the benchmark of its file name");
  assert.deepEqual(read(captured, targetConditions("frame-records")), [
    `${captured}: reports traceState false, expected true of resize-catch-up in the state captured`,
    `${captured}: reports logPolicy ${JSON.stringify(policyOf("frame-records"))}, expected ${JSON.stringify(policyOfSetting(capturedSettings["diagnostics.log"]).classes)} of resize-catch-up in the state captured`,
  ]);
  assert.deepEqual(read("make benchmark-view-drag", targetConditions(0)),
    ["make benchmark-view-drag: names no TRACE, and view-drag measures in the states 0 and frame-records"]);
  assert.deepEqual(read("make benchmark-resize-catch-up TRACE=0", targetConditions(0)),
    ["make benchmark-resize-catch-up TRACE=0: resize-catch-up measures in no state 0"]);
  assert.deepEqual(read("make benchmark-split-load TRACE=0", targetConditions(0), "S10"),
    ["make benchmark-split-load TRACE=0: names TRACE=0, and split-load measures in one state"]);
  assert.deepEqual(read("e2e/benchmark/hwp-view.test.mjs", targetConditions(0), "S7"),
    ["e2e/benchmark/hwp-view.test.mjs: e2e/benchmark/measurements.mjs declares no settings of hwp-view in B3_SETTINGS"]);
  assert.deepEqual(read("e2e/benchmark/section-view.test.mjs", targetConditions(0), "S7"),
    ["e2e/benchmark/section-view.test.mjs: e2e/benchmark/measurements.mjs declares no measurements of section-view in B3_MEASUREMENTS"]);
});

test("the run reads the declarations of the e2e benchmarks from e2e/benchmark/measurements.mjs", { timeout: 1000 }, async () => {
  const runner = await import("../benchmark-b3.mjs");
  assert.deepEqual(runner.BENCHMARKS, { measurements: B3_MEASUREMENTS, settings: B3_SETTINGS });
  assert.equal(runner.BENCHMARKS.settings, B3_SETTINGS, "the run passes the declarations of the module, not a copy");
});

test("B3_SETTINGS of a benchmark has the shape of its B3_MEASUREMENTS, and a missing or an extra state or another shape fails the run", { timeout: 1000 }, (t) => {
  const goals = fixtureGoals();
  const declared = BENCHMARKS.settings["resize-catch-up"];
  const captured = "make benchmark-resize-catch-up TRACE=captured";
  const read = (target, settings, scenario = "S5") => readTargetOutput(
    outputFile(t, { measurements: { verdict: "passed" }, conditions: settingsConditions(declared.captured) }),
    { goals, scenario, target, application: { host: "wailsv3" }, trace: 0, code: 0, benchmarks: { ...BENCHMARKS, settings: { ...BENCHMARKS.settings, ...settings } } }).failures;
  assert.deepEqual({
    extra: read(captured, { "resize-catch-up": { ...declared, 0: traceSettings(0) } }),
    missing: read(captured, { "resize-catch-up": { captured: declared.captured } }),
  }, {
    extra: [`${captured}: B3_SETTINGS declares the state 0 of resize-catch-up, which B3_MEASUREMENTS of resize-catch-up does not hold`],
    missing: [`${captured}: B3_SETTINGS declares no settings of the state frame-records of resize-catch-up, which B3_MEASUREMENTS of resize-catch-up holds`],
  });
  assert.deepEqual(read(captured, { "resize-catch-up": declared.captured }), [
    `${captured}: B3_SETTINGS declares the state diagnostics.performance of resize-catch-up, which B3_MEASUREMENTS of resize-catch-up does not hold`,
    `${captured}: B3_SETTINGS declares the state diagnostics.log of resize-catch-up, which B3_MEASUREMENTS of resize-catch-up does not hold`,
    `${captured}: B3_SETTINGS declares no settings of the state captured of resize-catch-up, which B3_MEASUREMENTS of resize-catch-up holds`,
    `${captured}: B3_SETTINGS declares no settings of the state frame-records of resize-catch-up, which B3_MEASUREMENTS of resize-catch-up holds`,
  ], "a settings object in place of the states of an object of B3_MEASUREMENTS fails on each state");
  const split = "make benchmark-split-load";
  assert.deepEqual(read(split, { "split-load": { 0: BENCHMARKS.settings["split-load"] } }, "S10"),
    [`${split}: B3_SETTINGS of split-load is {"0":{"diagnostics.performance":false,"diagnostics.log":{"call":"debug"}}}, expected one settings object {"diagnostics.performance": boolean, "diagnostics.log": {class: level}} for the list of keys of B3_MEASUREMENTS of split-load`]);
});

test("a benchmark records its verdict as a measurement, and a target that exits with another code than 0 fails the run", { timeout: 1000 }, (t) => {
  const goals = fixtureGoals();
  const target = "make benchmark-view-drag TRACE=0";
  const read = (measurements, code) => readTargetOutput(outputFile(t, { measurements, conditions: targetConditions() }),
    { goals, scenario: "S5", target, application: { host: "mygo" }, trace: 0, code, benchmarks: BENCHMARKS });
  assert.deepEqual(read({ verdict: "failed" }, 0), { values: { "G4-S5-view-drag": "failed" }, conditions: targetConditions(), failures: [] });
  assert.deepEqual(read({ verdict: "passed" }, 0).values, { "G4-S5-view-drag": "passed" });
  assert.deepEqual(read({ verdict: "failed" }, 1), { values: {}, conditions: null, failures: [`${target} exited with code 1`] }, "a target with an error writes no output that the run reads");
  assert.deepEqual(read({ verdict: 1 }, 0).failures, [`G4-S5-view-drag: ${target} wrote the measurement verdict as 1, expected passed or failed`]);
  assert.deepEqual(read({ dragCpuSeconds: 1 }, 0).failures, [`G4-S5-view-drag: ${target} wrote no measurement verdict`]);
});

/** The occluded of the first window of the application of configDir. */
async function readOccluded(configDir) {
  const client = await connect({ configDir });
  try {
    const [{ window }] = await client.request("windows.list");
    return (await client.request("status.get", { window, name: "host.window" })).occluded;
  } finally {
    client.close();
  }
}

/**
 * The context of runUnit for a fixture application: the application serves the refresh rate and the backing scale that the test sets
 * in its environment, the readings of the start conditions are injected, and each target writes, under the measurement key of each
 * entry of its row, the reading of `values` for the id of that entry.
 */
function fixtureContext(t, { refreshRate = 120, backingScale = 2, exit = false, values = {} } = {}) {
  const environment = { B3_FIXTURE_REFRESH_RATE: String(refreshRate), B3_FIXTURE_BACKING_SCALE: String(backingScale), B3_FIXTURE_EXIT: exit ? "1" : "0" };
  const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const session = folder(t);
  const goals = fixtureGoals();
  const application = {
    name: "mygo", host: "mygo", build: "current", checkout: ROOT, bundle: join(FIXTURES, "application.mjs"),
    executable: join(FIXTURES, "application.mjs"), sok: join(FIXTURES, "sok.mjs"), index: join(session, "index.json"),
  };
  writeFileSync(application.index, JSON.stringify({ plugins: [], sidecars: [] }));
  createSession(session, { phase: "final", runs: goals.runs, applications: [application], builds: {}, toolchains: {}, baseline: baselineRecord(), sidecars: { sidecars: [] } });
  const lines = [];
  const targets = [];
  const context = {
    goals, session, write: (line) => lines.push(line), benchmarks: BENCHMARKS,
    readStart: async () => ({ loadAverage: [1, 1, 1], swap: { usedBytes: 0, totalBytes: 1 << 30 }, fseventsdCores: 0.01 }),
    loadAverage: () => [1, 2, 3],
    runTarget: async (command, { target }) => {
      targets.push(target);
      const owned = goals.values.filter((value) => value.target === target && Object.hasOwn(values, value.id));
      const measurements = Object.fromEntries(owned.map((value) => [value.measurement, values[value.id]]));
      writeFileSync(command.out, JSON.stringify({ measurements, conditions: targetConditions() }));
      return { code: 0 };
    },
  };
  return { context, application, lines, targets, session };
}

test("a run of a fixture application fails on a display at another refresh rate or backing scale and quits the application, and no process of it remains", { timeout: 30000 }, async (t) => {
  for (const [refreshRate, backingScale, expected] of [[60, 2, "the display mode runs at 60 Hz, expected 120 Hz"], [120, 1, "the backing scale of the window is 1, expected 2"]]) {
    const { context, application, lines, targets, session } = fixtureContext(t, { refreshRate, backingScale });
    const records = await runUnit({ scenarios: ["S0"], run: 1, application }, context);
    assert.deepEqual(records.map((record) => record.failures), [[expected]], lines.join("\n"));
    assert.deepEqual(targets, [], "a run on a display outside the conditions measures nothing");
    assert.ok(lines.some((line) => line.startsWith("passed quit mygo ")), lines.join("\n"));
    assert.ok(lines.some((line) => line.startsWith("passed remaining processes ")), lines.join("\n"));
    assert.deepEqual(readSession(session).records.map((record) => record.failures), [[expected]]);
    assert.equal(existsSync(join(session, "configs", "S0-1-mygo")), true, "a failed run keeps its configuration folder");
  }
});

test("a run of a fixture application that exits before it writes its endpoint fails and measures nothing", { timeout: 30000 }, async (t) => {
  const { context, application, targets } = fixtureContext(t, { exit: true });
  const [record] = await runUnit({ scenarios: ["S0"], run: 1, application }, context);
  assert.deepEqual(record.failures, ["start mygo: the application exited with code 3 before it wrote endpoint.json"], "the quit of an application that did not start is skipped");
  assert.equal(record.display, null);
  assert.deepEqual(targets, []);
});

test("a window that opens behind the front is activated before the first target of a run", { timeout: 30000 }, async (t) => {
  const { context, application, targets } = fixtureContext(t);
  const before = [];
  const runTarget = context.runTarget;
  context.runTarget = async (command, options) => {
    before.push(await readOccluded(command.argv.find((word) => word.startsWith("CONFIG=")).slice("CONFIG=".length)));
    return runTarget(command, options);
  };
  const [record] = await runUnit({ scenarios: ["S0"], run: 1, application }, context);
  assert.ok(targets.length > 0, JSON.stringify(record.failures));
  assert.deepEqual([...new Set(before)], [false], "a target reads a covered window, which fails its reading of occluded");
});

test("a run whose activation is refused or whose window stays covered fails and measures nothing", { timeout: 30000 }, async (t) => {
  for (const [variable, expected] of [["B3_FIXTURE_ACTIVATION_FAILS", /the window is not active/], ["B3_FIXTURE_COVERED", /window main reports occluded true after its activation/]]) {
    process.env[variable] = "1";
    try {
      const { context, application, targets } = fixtureContext(t);
      const [record] = await runUnit({ scenarios: ["S0"], run: 1, application }, context);
      assert.equal(record.failures.length, 1, JSON.stringify(record.failures));
      assert.match(record.failures[0], expected);
      assert.deepEqual(targets, []);
    } finally {
      delete process.env[variable];
    }
  }
});

test("a run that starts outside the run conditions starts no application", { timeout: 10000 }, async (t) => {
  const { context, application, lines } = fixtureContext(t);
  context.readStart = async () => ({ loadAverage: [1, 1, 1], swap: { usedBytes: 600, totalBytes: 1000 }, fseventsdCores: 0.01 });
  const [record] = await runUnit({ scenarios: ["S0"], run: 1, application }, context);
  assert.deepEqual(record.failures, ["swap use 600 B is not below 0.5 of the swap total 1000 B"]);
  assert.ok(!lines.some((line) => line.startsWith("running start ")), lines.join("\n"));
});

test("a run of a fixture application measures each scenario of its unit in one application and writes one record per scenario into the session folder", { timeout: 30000 }, async (t) => {
  const values = { "G2-S0-frames": 0, "G2-S0-host-cpu": 0.05, "G3-S1-host-footprint": 70000 };
  const { context, application, targets, session, lines } = fixtureContext(t, { values });
  const records = await runUnit({ scenarios: ["S0", "S1"], run: 2, application }, context);
  assert.deepEqual(records.map((record) => [record.scenario, record.run, record.failures]), [["S0", 2, []], ["S1", 2, []]], lines.join("\n"));
  assert.deepEqual(targets, ["make measure-app-usage STATE=S0 IDLE=1 INTERVAL=240", "make measure-app-usage STATE=S1"]);
  assert.deepEqual(records[0].values, { "G2-S0-frames": 0, "G2-S0-host-cpu": 0.05 });
  assert.deepEqual(records[1].values, { "G3-S1-host-footprint": 70000 });
  assert.deepEqual(records[0].conditions, { "make measure-app-usage STATE=S0 IDLE=1 INTERVAL=240": targetConditions() });
  assert.deepEqual(records[1].conditions, { "make measure-app-usage STATE=S1": targetConditions() });
  assert.deepEqual(records[0].display, { refreshRate: 120, backingScale: 2 });
  assert.deepEqual(records[0].end, { loadAverage: [1, 2, 3] });
  assert.deepEqual(readSession(session).records, records);
  assert.equal(existsSync(join(session, "configs", "S0+S1-2-mygo")), false, "a passed run removes its configuration folder");
});

test("a failed benchmark is the verdict failed of its row, and a target that exits with another code than 0 fails the run", { timeout: 30000 }, async (t) => {
  const { context, application } = fixtureContext(t, { values: {} });
  context.runTarget = async (command, { target }) => {
    const failed = target === "make benchmark-view-drag TRACE=0";
    writeFileSync(command.out, JSON.stringify({ measurements: failed ? { verdict: "failed" } : { maximiseFrameP90Ms: 1 }, conditions: targetConditions() }));
    return { code: 0 };
  };
  const [record] = await runUnit({ scenarios: ["S5"], run: 1, application }, context);
  assert.deepEqual(record.failures, []);
  assert.deepEqual(record.values, { "G4-S5-view-drag": "failed" });
  context.runTarget = async () => ({ code: 2 });
  const [failed] = await runUnit({ scenarios: ["S10"], run: 1, application }, context);
  assert.deepEqual(failed.failures, ["make benchmark-split-load exited with code 2"]);
});

test("a target that cannot be run fails the run, and the application of the run quits", { timeout: 30000 }, async (t) => {
  const { context, application, lines } = fixtureContext(t);
  context.runTarget = async () => { throw new Error("cannot start make: spawn make ENOENT"); };
  const [record] = await runUnit({ scenarios: ["S10"], run: 1, application }, context);
  assert.deepEqual(record.failures, ["cannot start make: spawn make ENOENT"]);
  assert.ok(lines.some((line) => line.startsWith("passed quit mygo ")), lines.join("\n"));
  assert.ok(lines.some((line) => line.startsWith("passed remaining processes ")), lines.join("\n"));
});

test("the session folder holds the session, the baseline record and the sidecar record, and make check-b3 reads it", { timeout: 1000 }, (t) => {
  const session = folder(t);
  const goals = fixtureGoals();
  const applications = applicationsOf({ root: "/core", baseline: "/baseline" });
  createSession(session, { phase: "final", runs: goals.runs, applications, builds: {}, toolchains: { go: "go1.27.3", rust: "rustc 1.91.0" },
    baseline: baselineRecord(), sidecars: { sidecars: [] } });
  assert.deepEqual(JSON.parse(readFileSync(join(session, "baseline.json"), "utf8")), baselineRecord());
  assert.deepEqual(JSON.parse(readFileSync(join(session, "sidecar-revisions.json"), "utf8")), { sidecars: [] });
  for (const record of readSession(join(FIXTURES, "session")).records) appendRecord(session, record);
  const read = readSession(session);
  assert.equal(read.phase, "final");
  assert.deepEqual(read.applications, applications.map(({ name, host, build }) => ({ name, host, build })));
  assert.equal(judgeSession(goals, read).failures, 0);
});

test("make benchmark-b3 refuses a phase, a run count or a baseline checkout that it does not take before it reads anything", { timeout: 20000 }, () => {
  const run = (...vars) => spawnSync("make", ["-s", "--no-print-directory", "benchmark-b3", ...vars], { cwd: ROOT, encoding: "utf8" });
  assert.match(run("PHASE=2", "RUNS=7", "BASELINE=/baseline").stderr, /^benchmark-b3 requires PHASE=1\|final RUNS=<n> BASELINE=<checkout>$/m);
  assert.match(run("PHASE=final", "RUNS=0", "BASELINE=/baseline").stderr, /^benchmark-b3 requires PHASE=1\|final RUNS=<n> BASELINE=<checkout>$/m);
  assert.match(run("PHASE=final", "RUNS=7").stderr, /^benchmark-b3 requires PHASE=1\|final RUNS=<n> BASELINE=<checkout>$/m);
});

test("a target that reports a covered window fails its run", { timeout: 30000 }, async (t) => {
  const { context, application } = fixtureContext(t, { values: { "G2-S0-frames": 0, "G2-S0-host-cpu": 0.05 } });
  const runTarget = context.runTarget;
  context.runTarget = async (command, options) => {
    const result = await runTarget(command, options);
    const output = JSON.parse(readFileSync(command.out, "utf8"));
    writeFileSync(command.out, JSON.stringify({ ...output, conditions: { ...output.conditions, occluded: true } }));
    return result;
  };
  const [record] = await runUnit({ scenarios: ["S0"], run: 1, application }, context);
  assert.ok(record.failures.some((failure) => failure.endsWith("the window reports occluded true, expected false")), JSON.stringify(record.failures));
});

test("a target whose application lost its activation fails its run", { timeout: 30000 }, async (t) => {
  const { context, application } = fixtureContext(t, { values: { "G2-S0-frames": 0, "G2-S0-host-cpu": 0.05 } });
  const runTarget = context.runTarget;
  context.runTarget = async (command, options) => {
    const result = await runTarget(command, options);
    const output = JSON.parse(readFileSync(command.out, "utf8"));
    writeFileSync(command.out, JSON.stringify({ ...output, conditions: { ...output.conditions, active: false } }));
    return result;
  };
  const [record] = await runUnit({ scenarios: ["S0"], run: 1, application }, context);
  assert.ok(record.failures.some((failure) => failure.endsWith("the application reports active false, expected true")), JSON.stringify(record.failures));
});

test("each build step of a session names a target of the Makefile", { timeout: 1000 }, () => {
  const targets = new Set([...readFileSync(join(ROOT, "Makefile"), "utf8").matchAll(/^([A-Za-z0-9_.-]+):/gm)].map((match) => match[1]));
  for (const phase of ["1", "final"]) {
    for (const { argv } of buildSteps(phase, "/baseline").filter((step) => step.argv[0] === "make")) {
      const named = argv.slice(1).filter((word, index, words) => word !== "-C" && words[index - 1] !== "-C" && !word.includes("="));
      assert.deepEqual(named.filter((name) => !targets.has(name)), [], argv.join(" "));
    }
  }
});

test("the baseline record is one file of the git common directory, which every worktree shares and no clean of the build outputs removes", { timeout: 10000 }, (t) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "b3-record-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const main = join(folder, "main");
  const worktree = join(folder, "worktree");
  const git = (...args) => execFileSync("git", ["-C", main, "-c", "user.name=b3", "-c", "user.email=b3@test", ...args], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", main], { stdio: "pipe" });
  git("commit", "-q", "--allow-empty", "-m", "first");
  git("worktree", "add", "-q", worktree);
  const record = baselineRecordFile(main);
  assert.equal(record, join(main, ".git", "b3", "baseline.json"));
  assert.equal(baselineRecordFile(worktree), record);
});

test("a baseline host starts by the executable name of its revision and the other hosts by the current one", { timeout: 1000 }, () => {
  const executables = (build) => Object.fromEntries(applicationsOf({ root: "/core", baseline: "/base" }, build)
    .map((application) => [application.name, application.executable]));
  assert.deepEqual(executables("release"), {
    mygo: "/core/target/release/mygo/soksak.app/Contents/MacOS/sok-mygo",
    wailsv3: "/core/target/release/wailsv3/soksak.app/Contents/MacOS/sok-wailsv3",
    tauriv2: "/core/target/release/tauriv2/soksak.app/Contents/MacOS/sok-tauriv2",
    "baseline-wailsv3": "/base/target/release/wailsv3/soksak.app/Contents/MacOS/soksak-wailsv3",
    "baseline-tauriv2": "/base/target/release/tauriv2/soksak.app/Contents/MacOS/soksak-tauriv2",
  });
  assert.equal(executables("debug")["baseline-wailsv3"], "/base/target/debug/soksak-wailsv3.app/Contents/MacOS/soksak-wailsv3");
  assert.equal(executables("debug").wailsv3, "/core/target/debug/sok-wailsv3.app/Contents/MacOS/sok-wailsv3");
});

test("a session builds one host at a time, the Tauri hosts first, and removes the outputs of each build before the next", { timeout: 1000 }, () => {
  const made = (steps) => steps.filter(({ argv }) => argv[0] === "make").map(({ argv }) => argv.slice(1).join(" "));
  const steps = buildSteps("1", "/baseline");
  assert.deepEqual(made(steps), [
    "build-tauriv2-release", "-C /baseline build-tauriv2-release", "build-tauriv2", "-C /baseline build-tauriv2",
    "build-wailsv3-release", "-C /baseline build-wailsv3-release", "build-wailsv3", "-C /baseline build-wailsv3",
    "build-mygo-release", "build-mygo",
    "build-registry SIDECARS=diagnostic", "build-registry SIDECARS=diagnostic PLUGINS=public",
  ]);
  assert.deepEqual(made(buildSteps("final", "/baseline")), [
    "build-tauriv2-release", "-C /baseline build-tauriv2-release", "build-wailsv3-release", "-C /baseline build-wailsv3-release", "build-mygo-release",
    "build-registry SIDECARS=diagnostic", "build-registry SIDECARS=diagnostic PLUGINS=public",
  ]);
  steps.slice(0, -2).forEach((step, position) => {
    if (step.argv[0] === "make") {
      const next = steps[position + 1].argv;
      const checkout = step.argv[1] === "-C" ? "/baseline" : ROOT.replace(/\/$/, "");
      assert.equal(next[0], "rm", `${step.argv.join(" ")} is followed by ${next.join(" ")}`);
      assert.deepEqual(next.slice(2).sort(), ["debug", "release"].flatMap((profile) => ["build", "deps", ".fingerprint", "incremental"].map((name) => join(checkout, "target", profile, name))).sort());
    }
  });
});

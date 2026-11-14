import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";
import { Session } from "@soksak/window-check/app.mjs";

import { readB3Out, writeB3Out } from "../b3-out.mjs";
import { launchdServicesOfResult } from "@soksak/window-check/stall-sample.mjs";
import { footprintOfResult } from "../footprints.mjs";

import {
  applicationHost,
  applicationRowsOf,
  B3_MEASUREMENTS,
  COUNT_WAIT_MS,
  countWaitMs,
  cpuFigures,
  cpuSecondsOf,
  cpuPercent,
  faultErrorCount,
  framesQuietStep,
  framesQuietWaitMs,
  gestureFigures,
  hostProcess,
  idleOutcome,
  idleRemainingMs,
  idleWaitMs,
  intervalWaitMs,
  keyReadingWaitMs,
  logLineCounts,
  movePointer,
  notMeasuredLines,
  outputOf,
  parseCpuSamples,
  parseCpuTime,
  parseOptions,
  parseProcessTable,
  pointerGesture,
  pointerPath,
  prepareState,
  QUIET_INTERVALS,
  QUIET_MS,
  readIdleTimeouts,
  readWindowFrames,
  recordsOver,
  requireOcclusion,
  serveBlank,
  sidecarProcesses,
  STATES,
  totalsOf,
  unattributedRows,
  unreadOutcome,
  usageMeasurements,
  usageOutput,
  webkitPidsOf,
  webkitRows,
  windowRows,
  windowRowsOf,
} from "../measure-app-usage.mjs";

const DIR = "/Users/tester/Library/Application Support/sok-check";

// The recordings of the real tools (ps, launchctl, pgrep, footprint) that the judgements of the measurement read: each file holds the command
// that produced it and its process result {status, stdout, stderr}, recorded on macOS with the names of the machine replaced
// by neutral names (scripts/test/fixtures/measure-app-usage).
const RECORDINGS = fileURLToPath(new URL("./fixtures/measure-app-usage/", import.meta.url));
const recorded = (name) => JSON.parse(readFileSync(join(RECORDINGS, `${name}.json`), "utf8"));
const PS = recorded("ps-table");
const TABLE = parseProcessTable(PS.stdout);
const PIDS = PS.pids;

/**
 * The session of the window w1 on a client that is connected to the player of the endpoint case `name`, with the disposable
 * configuration folder of the application of the session. Closing the player fails when the case was not played.
 */
async function play(t, name, options) {
  const server = await startCasePlayer(name, options);
  const configDir = mkdtempSync(join(tmpdir(), "soksak-measure-usage-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const s = new Session({ name: "fixture", configDir }, client);
  s.window = "w1";
  return { s, server, configDir };
}

/** The policy file that the host writes for a value of the setting diagnostics.log (docs/spec/logging.md#policy-file). */
function writePolicy(configDir, classes) {
  const every = { lifecycle: "error", input: "error", call: "error", io: "error", frame: "error", ...classes };
  writeFileSync(join(configDir, "log-policy.json"), JSON.stringify({ schema: 1, classes: every }));
}

/** Writes the policy file after the request that sets the value of diagnostics.log, as the host does when the page sends it. */
function writePolicyOnSetting(server, configDir) {
  server.events.on("request", ({ method, params }) => {
    if (method === "command.run" && params.name === "core.settings.change" && params.params.key === "diagnostics.log") writePolicy(configDir, params.params.value);
  });
}

test("parses the cpu time formats of ps", () => {
  assert.equal(parseCpuTime("0:01.23"), 1.23);
  assert.equal(parseCpuTime("1:02:03.50"), 3723.5);
  assert.equal(parseCpuTime("2-01:00:00.00"), 2 * 86400 + 3600);
});

test("rejects a cpu time outside the ps format", () => {
  assert.throws(() => parseCpuTime("1:2"), /cpu time "1:2" is not in the \[\[dd-\]hh:\]mm:ss\.ss format/);
  assert.throws(() => parseCpuTime("0:75.00"), /cpu time "0:75.00" has seconds of 60 or more/);
});

test("cpu percent is the cpu seconds used over the interval", () => {
  assert.equal(cpuPercent(10, 12.5, 10), 25);
  assert.equal(cpuPercent(3, 3, 10), 0);
});

test("cpu percent rejects a decrease and a non-positive interval", () => {
  assert.throws(() => cpuPercent(5, 4, 10), /cpu time decreased from 5 to 4/);
  assert.throws(() => cpuPercent(1, 2, 0), /interval must be a positive number of seconds \(0\)/);
});

test("parses ps cpu samples into seconds per pid", () => {
  const samples = parseCpuSamples("  123  0:01.50\n  456 1:02:03.00\n");
  assert.deepEqual([...samples.entries()], [[123, 1.5], [456, 3723]]);
});

test("parses ps command rows and rejects a malformed row", () => {
  assert.deepEqual(parseProcessTable("  123 /a/b --config-dir /d\n  456 /c\n"), [
    { pid: 123, command: "/a/b --config-dir /d" },
    { pid: 456, command: "/c" },
  ]);
  assert.throws(() => parseProcessTable("not-a-row\n"), /process row "not-a-row" has no pid/);
});

test("finds the host by the config-dir argument and skips tools, sidecars and WebKit", () => {
  const table = parseProcessTable([
    `  10 /Applications/sok-check.app/Contents/MacOS/soksak --config-dir ${DIR}`,
    `  11 node scripts/measure-app-usage.mjs --sok /x/sok --config-dir ${DIR}`,
    `  12 /x/target/debug/sok windows --config-dir ${DIR}`,
    `  13 ${DIR}/sidecars/probe-service/build/probe --config-dir ${DIR}`,
    `  14 /System/Library/WebKit.framework/com.apple.WebKit.Networking --config-dir ${DIR}`,
    "  15 /usr/bin/other --config-dir /elsewhere",
  ].join("\n"));
  assert.deepEqual(hostProcess(table, DIR), { pid: 10 });
});

test("matches a data folder whose launch path has a doubled slash", () => {
  const launched = DIR.replace("/Library/", "//Library/");
  const table = parseProcessTable([
    `  10 /Applications/sok-check.app/Contents/MacOS/soksak --config-dir ${launched} --registry-ca ${launched}/ca.pem`,
    `  11 ${launched}/sidecars/probe/bin/probe --config-dir ${launched}`,
  ].join("\n"));
  assert.deepEqual(hostProcess(table, DIR), { pid: 10 });
  assert.deepEqual(sidecarProcesses(table, DIR), [{ role: "sidecar probe", pid: 11, attribution: "executable path" }]);
});

test("finds the host and the sidecars of a data folder that the processes launch by its real path", () => {
  const given = "/var/tester/sok-check";
  const real = "/private/var/tester/sok-check";
  const table = parseProcessTable([
    `  10 /Applications/sok-check.app/Contents/MacOS/soksak --config-dir ${real}`,
    `  11 ${real}/sidecars/probe/bin/probe --x`,
  ].join("\n"));
  assert.deepEqual(hostProcess(table, given, real), { pid: 10 });
  assert.deepEqual(sidecarProcesses(table, given, real), [{ role: "sidecar probe", pid: 11, attribution: "executable path" }]);
});

test("reports a missing or duplicate host", () => {
  const none = parseProcessTable("  15 /usr/bin/other --config-dir /elsewhere\n");
  assert.throws(() => hostProcess(none, DIR), /no host process has --config-dir .*sok-check/);
  const two = parseProcessTable(`  10 /a/soksak --config-dir ${DIR}\n  20 /b/soksak --config-dir ${DIR}\n`);
  assert.throws(() => hostProcess(two, DIR), /2 host processes have --config-dir/);
});

test("lists the sidecars whose executable is under the config dir", () => {
  const table = parseProcessTable([
    `  21 ${DIR}/sidecars/probe-service/build/probe-service --flag`,
    `  22 ${DIR}/sidecars/worker/bin/worker`,
    `  23 /other/sidecars/worker/bin/worker`,
  ].join("\n"));
  assert.deepEqual(sidecarProcesses(table, DIR), [
    { role: "sidecar probe-service", pid: 21, attribution: "executable path" },
    { role: "sidecar worker", pid: 22, attribution: "executable path" },
  ]);
});

/** The rows of the WebKit services of the recorded launchd domain `name` for the host of the data folder `configDir`. */
const domainRows = (name, configDir) => {
  const result = recorded(name);
  return webkitRows(configDir, launchdServicesOfResult(result.pid, result));
};

test("attributes the WebKit services to the application whose launchd domain lists them, for the recorded domains of three applications", () => {
  assert.deepEqual(domainRows("launchctl-print-all-services", DIR), [
    { configDir: DIR, role: "webkit webcontent", pid: 1648, attribution: "launchd domain" },
    { configDir: DIR, role: "webkit gpu", pid: 1413, attribution: "launchd domain" },
    { configDir: DIR, role: "webkit networking", pid: 1635, attribution: "launchd domain" },
  ]);
  assert.deepEqual(domainRows("launchctl-print-gpu-only", "/Users/tester/other"), [
    { configDir: "/Users/tester/other", role: "webkit gpu", pid: 1638, attribution: "launchd domain" },
  ]);
  assert.deepEqual(domainRows("launchctl-print-networking-only", "/Users/tester/another"), [
    { configDir: "/Users/tester/another", role: "webkit networking", pid: 76149, attribution: "launchd domain" },
  ]);
  assert.deepEqual(domainRows("launchctl-print-host", DIR), [], "a domain without a WebKit service has no row");
});

test("a host whose launchd domain cannot be read is an error that names the process", () => {
  const refused = recorded("launchctl-print-refused");
  assert.throws(() => launchdServicesOfResult(refused.pid, refused),
    /^Error: launchctl print pid\/0 exited with 112: Bad request\.\nCould not find domain for pid: 0$/);
});

test("totals count the attributed rows only and sum the sidecars apart from the application", () => {
  const rows = [
    { role: "host", pid: 10, bytes: 100, peakBytes: 120, cpuSeconds: 2, cpuPercent: 1 },
    { role: "page w1", pid: 20, bytes: 50, peakBytes: 60, cpuSeconds: 1, cpuPercent: 0.5 },
    { role: "sidecar probe", pid: 30, bytes: 7, peakBytes: 8, cpuSeconds: 0.5, cpuPercent: 0.25 },
    { role: "webkit gpu", pid: 40, bytes: null, peakBytes: null, cpuSeconds: null, cpuPercent: null },
  ];
  assert.deepEqual(totalsOf(rows), {
    application: { bytes: 150, peakBytes: 180, cpuSeconds: 3, cpuPercent: 1.5 },
    sidecars: { bytes: 7, peakBytes: 8, cpuSeconds: 0.5, cpuPercent: 0.25 },
    total: { bytes: 157, peakBytes: 188, cpuSeconds: 3.5, cpuPercent: 1.75 },
  });
  const zero = { bytes: 0, peakBytes: 0, cpuSeconds: 0, cpuPercent: 0 };
  assert.deepEqual(totalsOf([]), { application: zero, sidecars: zero, total: zero });
});

const MYGO = "/var/tester/soksak-check-mygo";
const MB = 1024 * 1024;

/** The host.window of a window of the mygo host: no main page, the frame counters of U7 and one image region of a tab surface. */
function mygoWindow(overrides = {}) {
  return {
    frame: { x: 100, y: 50, width: 1200, height: 788 },
    content: { x: 0, y: 28, width: 1200, height: 760 },
    occluded: false,
    pageProcess: null,
    frames: 340,
    commandBuffers: 338,
    settled: true,
    documents: [{ surface: "tab-2", document: "doc-1", process: 902 }],
    regions: [{ surface: "tab-1", name: "screen", presentedFrames: 120 }],
    ...overrides,
  };
}

test("the options take a state, the plugins of S1, the idle wait, the pointer step and the trace state", () => {
  assert.deepEqual(parseOptions(["--sok", "/b/sok", "--config-dir", MYGO, "--trace", "0"]),
    { sok: "/b/sok", configDirs: [MYGO], interval: 10, state: null, idle: false, step: null, trace: 0, b3Out: null, json: false, plugins: { tab: null, page: null } });
  assert.deepEqual(
    parseOptions(["--sok", "/b/sok", "--config-dir", MYGO, "--state", "S9", "--tab-plugin", "probeinput", "--page-plugin", "probeplain", "--idle", "--step", "pointer",
      "--trace", "1", "--interval", "240", "--b3-out", "/var/tester/b3/S9.json"]),
    { sok: "/b/sok", configDirs: [MYGO], interval: 240, state: "S9", idle: true, step: "pointer", trace: 1, b3Out: "/var/tester/b3/S9.json", json: false,
      plugins: { tab: "probeinput", page: "probeplain" } });
  assert.deepEqual(STATES, ["S0", "S0b", "S1", "S9", "S11", "S12", "S14", "S15"]);
  const base = ["--sok", "/b/sok", "--config-dir", MYGO, "--trace", "0"];
  assert.throws(() => parseOptions([...base, "--state", "S2"]), /--state must be one of S0, S0b, S1, S9, S11, S12, S14, S15 \(S2\)/);
  assert.throws(() => parseOptions([...base, "--step", "key"]), /--step must be pointer \(key\)/);
  for (const state of ["S1", "S9", "S11", "S12", "S15"]) {
    assert.throws(() => parseOptions([...base, "--state", state]), new RegExp(`^Error: --state ${state} prepares S1 and requires --tab-plugin ID --page-plugin ID$`));
    assert.throws(() => parseOptions([...base, "--state", state, "--page-plugin", "probeplain"]), /requires --tab-plugin ID --page-plugin ID/);
  }
  assert.equal(parseOptions([...base, "--state", "S0"]).state, "S0", "S0 opens no tab and takes no plugin");
  assert.throws(() => parseOptions([...base, "--state", "S14", "--tab-plugin", "probeinput", "--page-plugin", "probeplain"]),
    /^Error: --tab-plugin and --page-plugin name the tabs of S1, which --state S14 does not prepare$/);
  assert.throws(() => parseOptions(["--sok", "/b/sok", "--config-dir", MYGO]), /TRACE must be 0, 1 or frame-records, not set/);
  assert.throws(() => parseOptions([...base.slice(0, 4), "--trace", "2", "--step", "pointer"]), /TRACE must be 0, 1 or frame-records, not "2"/);
  assert.throws(() => parseOptions([...base, "--config-dir", "/var/tester/other", "--idle"]),
    /--state, --idle and --step prepare and measure one application; 2 --config-dir were given/);
  assert.throws(() => parseOptions([...base, "--config-dir", "/var/tester/other", "--b3-out", "/var/tester/b3.json"]),
    /--b3-out records one application; 2 --config-dir were given/);
  assert.throws(() => parseOptions([...base, "--b3-out", "b3.json"]), /--b3-out must be an absolute path \(b3.json\)/);
});

test("a window without a main page has no page process row and is no error", () => {
  const { rows, errors } = windowRows("w1", MYGO, mygoWindow());
  assert.deepEqual(rows, [{ role: "document tab-2/doc-1", pid: 902, attribution: "host.window" }]);
  assert.deepEqual(errors, []);
});

test("a window with a main page has its page row, and a page process that is neither a pid nor null is an error", () => {
  assert.deepEqual(windowRows("w1", MYGO, { pageProcess: 501, documents: [] }),
    { rows: [{ role: "page w1", pid: 501, attribution: "host.window" }], errors: [] });
  assert.deepEqual(windowRows("w1", MYGO, { pageProcess: 0, documents: [] }),
    { rows: [], errors: [`page of window w1 of ${MYGO}: no page process (0)`] });
  assert.deepEqual(windowRows("w1", MYGO, { pageProcess: null }),
    { rows: [], errors: [`page of window w1 of ${MYGO}: host.window reply has no documents array`] });
});

test("a hidden document that has not loaded has no row and is no error, and a shown document or a view without a process is an error", () => {
  const started = { surface: "tab-2", document: "", process: 902 };
  assert.deepEqual(windowRows("w1", MYGO, { pageProcess: null, documents: [started, { surface: "tab-2", document: "page", process: 0, visible: false }] }),
    { rows: [{ role: "document tab-2/", pid: 902, attribution: "host.window" }], errors: [] });
  assert.deepEqual(windowRows("w1", MYGO, { pageProcess: null, documents: [{ surface: "tab-2", document: "page", process: 0, visible: true }] }),
    { rows: [], errors: [`document tab-2/page of window w1 of ${MYGO}: no process (0)`] });
  assert.deepEqual(windowRows("w1", MYGO, { pageProcess: null, documents: [{ surface: "tab-2", document: "", process: 0, visible: false }] }),
    { rows: [], errors: [`document tab-2/ of window w1 of ${MYGO}: no process (0)`] });
});

test("every window must be visible except the covered first window of S9", () => {
  const visible = [{ window: "w1", occluded: false }, { window: "w2", occluded: false }];
  requireOcclusion("S1", visible);
  requireOcclusion(null, visible);
  assert.throws(() => requireOcclusion("S11", [{ window: "w1", occluded: false }, { window: "w2", occluded: true }]),
    /window w2 reports occluded true; S11 requires occluded false/);
  assert.throws(() => requireOcclusion("S9", visible), /window w1 reports occluded false; S9 requires occluded true/);
  requireOcclusion("S9", [{ window: "w1", occluded: true }, { window: "w2", occluded: false }]);
  assert.throws(() => requireOcclusion("S0", [{ window: "w1", occluded: "no" }]), /window w1 reports occluded "no", not a boolean/);
});

test("an idle wait over a window whose frames is null reports that no frame was read, and the two readings 3 seconds apart are quiet", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-idle-null-frames");
  assert.deepEqual(await readIdleTimeouts({ sessions: [s] }), []);
  const previous = await readWindowFrames({ sessions: [s] });
  const current = await readWindowFrames({ sessions: [s] });
  assert.equal(framesQuietStep({ previous, current, interval: 1 }), "quiet");
  assert.equal(idleOutcome(current), "not measured");
  await server.played;
});

test("an idle wait over two windows reports that no frame was read when one of them reports frames null", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-idle-mixed-frames");
  const sessions = [s, s.on("w2")];
  assert.deepEqual(await readIdleTimeouts({ sessions }), []);
  const previous = await readWindowFrames({ sessions });
  const current = await readWindowFrames({ sessions });
  assert.equal(framesQuietStep({ previous, current, interval: 1 }), "quiet");
  assert.equal(idleOutcome(current), "not measured");
  await server.played;
});

test("an idle wait over windows whose frames hold still reports quiet", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-idle-quiet-frames");
  const sessions = [s, s.on("w2")];
  assert.deepEqual(await readIdleTimeouts({ sessions }), []);
  const previous = await readWindowFrames({ sessions });
  const current = await readWindowFrames({ sessions });
  assert.equal(framesQuietStep({ previous, current, interval: 1 }), "quiet");
  assert.equal(idleOutcome(current), "quiet");
  await server.played;
});

test("the report names the counters that no window reports and an idle wait that read no frame", () => {
  const counted = { window: "w1", frames: 3, commandBuffers: 3 };
  const blank = { window: "w1", frames: null, commandBuffers: null };
  assert.deepEqual(notMeasuredLines({ idle: "not measured", marks: { before: [blank], after: [blank] } }), [
    "idle: not measured: the wait read no frame of a window whose frames is null, so it only waited",
    "not measured: frames of host.window is null in every window",
    "not measured: commandBuffers of host.window is null in every window",
  ]);
  assert.deepEqual(notMeasuredLines({ idle: "quiet", marks: { before: [counted], after: [counted] } }), []);
  assert.deepEqual(notMeasuredLines({ idle: null, marks: { before: [counted], after: [counted] } }), []);
});

test("the frames of every window must not change for 3 seconds, and the readings are 3 seconds apart", { timeout: 30000 }, async (t) => {
  assert.equal(QUIET_MS, 3000);
  const { s, server } = await play(t, "measure-idle-frames-change");
  assert.deepEqual(await readIdleTimeouts({ sessions: [s] }), []);
  const readings = [];
  for (let reading = 0; reading < 3; reading++) readings.push(await readWindowFrames({ sessions: [s] }));
  await server.played;
  assert.deepEqual(readings.map(([frames]) => frames), [10, 12, 12]);
  assert.deepEqual([1, 2].map((interval) => framesQuietStep({ previous: readings[interval - 1], current: readings[interval], interval })), ["again", "quiet"]);
  assert.deepEqual(server.requests.map(({ params }) => params.name), ["core.surfaces", "host.window", "host.window", "host.window"], "the readings at the start, after 3 s and after 6 s");
});

test("the waits of the idle wait are functions of the instants of the readings: 3 seconds after the frames reading, the longest cursor idle timeout, 62 seconds after the marks, 10 seconds after the key and the interval after the first CPU reading", () => {
  assert.deepEqual([100, 1100, 3100, 9000].map((now) => framesQuietWaitMs({ readAt: 100, now })), [3000, 2000, 0, 0]);
  assert.deepEqual([0, 200, 700, 900].map((now) => idleRemainingMs({ readAt: 0, now, idleTimeouts: [500, 700] })), [700, 500, 0, 0]);
  assert.equal(idleRemainingMs({ readAt: 0, now: 0, idleTimeouts: [] }), 0, "a window without a cursor tab waits no idle timeout");
  assert.deepEqual([5, 40005, 62005, 70000].map((now) => countWaitMs({ markedAt: 5, now })), [62000, 22000, 0, 0]);
  assert.deepEqual([7, 4007, 10007].map((now) => keyReadingWaitMs({ keyAt: 7, now })), [10000, 6000, 0]);
  assert.deepEqual([0, 239000, 240000, 241000].map((now) => intervalWaitMs({ startedAt: 0, now, interval: 240 })), [240000, 1000, 0, 0]);
  assert.throws(() => framesQuietWaitMs({ readAt: 100, now: 99 }), /the instant 99 ms is before the instant 100 ms/);
});

test("the readings of the frames judge quiet at the first equal pair, again at a change, and fail when each of the 40 intervals changed", () => {
  assert.equal(QUIET_INTERVALS, 40);
  const judge = (previous, current, interval = 1) => framesQuietStep({ previous, current, interval });
  assert.equal(judge([12, 40], [12, 40]), "quiet");
  assert.equal(judge([null], [null]), "quiet", "a window whose frames is null counts no frame");
  assert.equal(judge([10, null], [12, null]), "again");
  assert.equal(judge([10], [12], QUIET_INTERVALS - 1), "again");
  assert.equal(judge([3], [3], QUIET_INTERVALS), "quiet");
  assert.throws(() => judge([1], [2], QUIET_INTERVALS), /the frames of the windows changed in each of 40 intervals of 3 s; frames 1 then 2/);
});

test("the idle wait before the frames is the longest cursor idle timeout, or none without a cursor tab", () => {
  assert.equal(idleWaitMs([5000, 7000]), 7000);
  assert.equal(idleWaitMs([7000, 5000]), 7000);
  assert.equal(idleWaitMs([]), 0);
});

test("the idle wait reads the cursor idle timeout of every tab whose plugin exposes its cursor status and then the frames", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-idle-cursor-tabs");
  const idleTimeouts = await readIdleTimeouts({ sessions: [s] });
  assert.deepEqual(idleTimeouts, [500, 700]);
  assert.equal(idleWaitMs(idleTimeouts), 700);
  const previous = await readWindowFrames({ sessions: [s] });
  const current = await readWindowFrames({ sessions: [s] });
  assert.equal(idleOutcome(current), "not measured");
  assert.equal(framesQuietStep({ previous, current, interval: 1 }), "quiet");
  await server.played;
  assert.deepEqual(server.requests.filter(({ method }) => method === "status.get").map(({ params }) => [params.name, params.surface]).slice(0, 3),
    [["core.surfaces", undefined], ["probeinput.cursor", "tab-1"], ["rasterprobe.cursor", "tab-3"]]);
});

test("a cursor status whose idle timeout is not a number of milliseconds fails the idle wait", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-idle-cursor-timeout-text");
  await assert.rejects(readIdleTimeouts({ sessions: [s] }), /surface tab-1 of window w1 reports probeinput.cursor idleTimeout "5s", not a number of milliseconds/);
  await server.played;
});

test("counts the error lines of the layout fault in the application log", () => {
  const lines = [
    "error workbench surface presentation failed: diagnostic layout fault",
    "info host host run: soksak pid 10",
    "error workbench core.workbench.error: another fault",
    "warn page surface presentation failed: diagnostic layout fault",
  ];
  assert.equal(faultErrorCount(lines), 1);
  assert.equal(faultErrorCount([...lines, lines[0]]), 2);
});

/** The canonical decimal nanoseconds of the host event clock at `micros` microseconds after a clock reading of 9 s. */
const ns = (micros) => String(9_000_000_000n + BigInt(micros) * 1000n);

/**
 * The U7 records of a pointer move over window w1 of the mygo host from seq 101 on: for each move a `hitTest:` step, the
 * `mouseMoved:` step that follows it and a frame, each step as [entry, return] in microseconds.
 */
function u7Move(moves) {
  const records = [];
  let seq = 100;
  for (const [hitTest, moved] of moves) {
    for (const [callback, [entry, back]] of [["hitTest:", hitTest], ["mouseMoved:", moved]]) {
      records.push({ seq: ++seq, event: "host.frame.step", fields: { window: "w1", kind: "selector", callback, entry_ns: ns(entry), return_ns: ns(back), forwarded: 2, wait_ns: "40000" } });
    }
    records.push({
      seq: ++seq,
      event: "host.frame.record",
      fields: {
        window: "w1", start_ns: ns(moved[1]), request_ns: ns(moved[1] + 3000), end_ns: ns(moved[1] + 4000), damage: true, nodes: 48,
        drawable_wait_ns: "0", outcome: "transaction", command_buffer: seq, asks_frame: false, animates: false, repaints: false, timer: false,
      },
    });
  }
  return records;
}

const MOVES = [
  [[0, 1000], [1000, 2000]],
  [[10000, 10500], [10500, 12000]],
  [[20000, 23000], [23000, 26000]],
  [[30000, 30200], [30200, 30400]],
];

test("the gesture figures are the 90th percentile of the mouseMoved: steps with the hitTest: step right before each", () => {
  const figures = gestureFigures({ records: u7Move(MOVES), dropped: [], window: "w1", framesBefore: 340, framesAfter: 344, fromSeq: 100, toSeq: 112 });
  assert.deepEqual(figures, { frameRecords: 4, moves: 4, p90Ms: 6, framesChange: 4 });
});

/** The records of the steps `[callback, entry, return]` of window w1, with no frame record. */
function u7Steps(steps) {
  return steps.map(([callback, entry, back], index) => ({ seq: 100 + index + 1, event: "host.frame.step",
    fields: { window: "w1", kind: "selector", callback, entry_ns: ns(entry), return_ns: ns(back), forwarded: 0, wait_ns: "0" } }));
}

const steps = (list) => ({ records: u7Steps(list), dropped: [], window: "w1", framesBefore: 10, framesAfter: 10, fromSeq: 100, toSeq: 100 + list.length });

test("a move that the tracking area delivers has a value without a hitTest: step", () => {
  assert.deepEqual(gestureFigures(steps([["mouseMoved:", 0, 2000], ["mouseMoved:", 10000, 11000], ["mouseMoved:", 20000, 23000]])),
    { frameRecords: 0, framesChange: 0, moves: 3, p90Ms: 3 });
});

test("only the hitTest: step right before a move adds to that move", () => {
  assert.deepEqual(gestureFigures(steps([["hitTest:", 0, 1000], ["mouseMoved:", 1000, 2000], ["hitTest:", 10000, 14000], ["isFlipped", 14000, 15000],
    ["mouseMoved:", 20000, 21000]])), { frameRecords: 0, framesChange: 0, moves: 2, p90Ms: 2 });
});

test("a gesture without a delivered move and a gesture with incomplete records fail", () => {
  assert.throws(() => gestureFigures(steps([["hitTest:", 0, 1000], ["isFlipped", 1000, 2000]])), /the gesture of window w1 has no mouseMoved: step/);
  assert.throws(() => gestureFigures({ records: [], dropped: [], window: "w1", framesBefore: 340, framesAfter: 340, fromSeq: 100, toSeq: 100 }),
    /the gesture of window w1 has no mouseMoved: step/);
  assert.throws(() => gestureFigures({ records: u7Move(MOVES), dropped: [], window: "w1", framesBefore: 340, framesAfter: 345, fromSeq: 100, toSeq: 112 }),
    /the gesture of window w1 has 4 frame records for a change of frames of 5/);
});

test("a nested step is part of the step that contains it and is not added again", () => {
  // The isFlipped that the hitTest: sends runs inside it, and the isFlipped of the move runs inside the move.
  assert.deepEqual(gestureFigures(steps([["isFlipped", 100, 200], ["hitTest:", 0, 1000], ["isFlipped", 1200, 1300], ["mouseMoved:", 1100, 4100]])),
    { frameRecords: 0, framesChange: 0, moves: 1, p90Ms: 4 });
});

test("the pointer path moves across the content of the window at its middle in the coordinates of input.pointer", () => {
  const path = pointerPath(mygoWindow());
  assert.equal(path.length, 61);
  assert.ok(path.every((step) => step.y === 380));
  assert.deepEqual([path[0].x, path.at(-1).x], [1, 1199]);
});

test("the measurement does not import the real-input tool", () => {
  assert.doesNotMatch(readFileSync(fileURLToPath(new URL("../measure-app-usage.mjs", import.meta.url)), "utf8"), /e2e\/real|hid\.|bringFront|requireTrusted/);
});

test("the pointer move sends input.pointer moves without activating the window, each after the answer of the one before it", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-pointer-move");
  await movePointer(s, pointerPath(await s.get("host.window")));
  await server.played;
  const moves = server.requests.filter(({ method }) => method === "input.pointer");
  assert.equal(moves.length, 61);
  assert.deepEqual(moves[0].params, { window: "w1", x: 1, y: 380, phase: "move" });
});

/** The values of the host in the cases of the repeated move: the log positions and the rows of the U7 records of the host process of the test. */
function gestureValues() {
  const host = `host-1-${process.pid}`;
  const rows = (records) => records.map((event) => ({ role: "host", boot: `1-${process.pid}`, event }));
  const moves = u7Move(MOVES);
  return {
    "tail-before": { [host]: 100 },
    "tail-after": { [host]: 100 + moves.length },
    "frame-rows": rows(moves.filter((record) => record.event === "host.frame.record")),
    "step-rows": rows(moves.filter((record) => record.event === "host.frame.step")),
  };
}

test("the repeated move sets the trace state of the frame records, reads the frames of the move before the flush, reads the U7 records and sets the trace state again", { timeout: 30000 }, async (t) => {
  const { s, server, configDir } = await play(t, "measure-pointer-gesture", { values: gestureValues() });
  writePolicyOnSetting(server, configDir);
  const gesture = await pointerGesture({ s, status: await s.get("host.window"), trace: 0 });
  await server.played;
  assert.equal(server.requests.filter(({ method }) => method === "input.pointer").length, 61);
  assert.deepEqual(gesture, { window: "w1", frameRecords: 4, moves: 4, p90Ms: 6, framesChange: 4 });
});

test("the repeated move of a window with a main page repeats the move and reads no U7 records", { timeout: 30000 }, async (t) => {
  const { s, server, configDir } = await play(t, "measure-pointer-gesture-main-page");
  writePolicyOnSetting(server, configDir);
  assert.equal(await pointerGesture({ s, status: await s.get("host.window"), trace: 0 }), null);
  await server.played;
  assert.equal(server.requests.some(({ method }) => method === "log.query"), false);
});

test("a move that input.pointer refuses fails the repeated move and sets the trace state again", { timeout: 30000 }, async (t) => {
  const { s, server, configDir } = await play(t, "measure-pointer-gesture-refused", { values: { "tail-before": gestureValues()["tail-before"] } });
  writePolicyOnSetting(server, configDir);
  await assert.rejects(pointerGesture({ s, status: await s.get("host.window"), trace: 0 }), (error) => error.code === 1006 && /the window is not active/.test(error.message));
  await server.played;
  assert.deepEqual(server.requests.filter(({ method }) => method === "command.run").map(({ params }) => [params.params.key, params.params.value]).slice(-2),
    [["diagnostics.log", {}], ["diagnostics.performance", false]]);
});

const URL_BLANK = "http://127.0.0.1:4100/blank";

/** The data that prepareState takes: the trace state, the address of the blank page, and the folder of the second project of S11. */
const prepareDeps = (extra = {}) => ({ trace: 0, url: URL_BLANK, ...extra });

/** The plugins of the two tabs of S1: fixture plugins of e2e/fixtures. */
const S1_PLUGINS = { tab: "probeinput", page: "probeplain" };

/** The commands and requests of a prepared state in the order that the host received them, without the reads and the waits of a status. */
const received = (server) => server.requests.filter(({ method }) => method !== "status.get" && !method.startsWith("status."))
  .map(({ method, params }) => (method === "command.run" ? ["run", params.window, params.name, params.params, params.surface] : [method, params.window]));

/** The commands that S1 and every state after it run before the part of the state itself. */
const S1_STEPS = [
  ["run", "w1", "host.window.resize", { width: 1200, height: 760 }, undefined],
  ["diagnostics.fixture", "w1"],
  ["run", "w1", "core.settings.change", { key: "diagnostics.log", value: {}, scope: "common" }, undefined],
  ["run", "w1", "core.settings.change", { key: "diagnostics.performance", value: false, scope: "common" }, undefined],
  ["run", "w1", "core.card.add-tab", { card: "c1", plugin: "probeinput" }, undefined],
  ["run", "w1", "core.tab.close", { tab: "t-old" }, undefined],
  ["run", "w1", "core.card.split", { card: "c1", side: "right", plugin: "probeplain" }, undefined],
  ["run", "w1", "probeplain.navigate", { url: URL_BLANK }, "t-web"],
];

test("S1 opens one tab of the tab plugin and one tab of the page plugin on the blank loopback page in a window of 1200 by 760 points", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-state-s1");
  const context = await prepareState(s, "S1", prepareDeps(), S1_PLUGINS);
  await server.played;
  assert.deepEqual(received(server), S1_STEPS);
  assert.deepEqual(context, { state: "S1", windows: ["w1"], url: URL_BLANK, footprints: "settled" });
});

test("a state that starts from S1 requires the plugins of its tab and its page and the address of the blank page", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-state-no-request");
  for (const state of ["S1", "S9", "S11", "S12", "S15"]) {
    await assert.rejects(prepareState(s, state, prepareDeps()), new RegExp(`^Error: ${state} prepares S1, which requires the plugins of its tab and its page$`));
    await assert.rejects(prepareState(s, state, prepareDeps(), { tab: "probeinput" }), /which requires the plugins of its tab and its page/);
    await assert.rejects(prepareState(s, state, { trace: 0 }, S1_PLUGINS), new RegExp(`^Error: ${state} prepares S1, which requires the address of the blank page$`));
  }
  await assert.rejects(prepareState(s, "S11", prepareDeps(), S1_PLUGINS), /^Error: S11 requires the folder of its second project$/);
  await assert.rejects(prepareState(s, "S2", prepareDeps()), /the state S2 is not one of S0, S0b, S1, S9, S11, S12, S14, S15/);
  assert.deepEqual(server.requests, []);
});

test("the page plugin must expose its navigate command and its location status", { timeout: 30000 }, async (t) => {
  const plugins = { tab: "probeinput", page: "probeclose" };
  const navigate = await play(t, "measure-state-s1-navigate-missing");
  await assert.rejects(prepareState(navigate.s, "S1", prepareDeps(), plugins),
    /^Error: the page plugin probeclose of S1 does not expose command probeclose\.navigate; surface t-web exposes \["status probeclose\.location"\]$/);
  await navigate.server.played;
  const bare = await play(t, "measure-state-s1-entries-missing");
  await assert.rejects(prepareState(bare.s, "S1", prepareDeps(), plugins),
    /^Error: the page plugin probeclose of S1 does not expose command probeclose\.navigate and status probeclose\.location; surface t-web exposes \[\]$/);
  await bare.server.played;
});

test("S0 keeps the library screen of one window without a plugin view", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-state-s0");
  assert.deepEqual(await prepareState(s, "S0", prepareDeps()), { state: "S0", windows: ["w1"], footprints: "settled" });
  await server.played;
  assert.deepEqual(received(server), S1_STEPS.slice(0, 1).concat(S1_STEPS.slice(2, 4)));
});

test("S0 fails with plugin views or the workspace in the window", { timeout: 30000 }, async (t) => {
  const shown = await play(t, "measure-state-s0-views");
  await assert.rejects(prepareState(shown.s, "S0", prepareDeps()), /S0 requires a window without plugin views; window w1 shows t-term, t-web/);
  await shown.server.played;
  const project = await play(t, "measure-state-s0-project");
  await assert.rejects(prepareState(project.s, "S0", prepareDeps()), /S0 requires the library screen; window w1 shows workspace/);
  await project.server.played;
});

test("S14 keeps the library screen and types one character into the library search 10 seconds before the reading", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-state-s14");
  const { keyAt, ...context } = await prepareState(s, "S14", prepareDeps());
  assert.deepEqual(context, { state: "S14", windows: ["w1"], footprints: "at-once" });
  assert.equal(keyReadingWaitMs({ keyAt, now: keyAt }), 10000, "the reading is 10 seconds after the key");
  await server.played;
  assert.deepEqual(received(server), S1_STEPS.slice(0, 1).concat(S1_STEPS.slice(2, 4), [
    ["run", "w1", "core.library.search.focus", {}, undefined],
    ["input.key", "w1"],
    ["input.key", "w1"],
  ]));
  assert.deepEqual(server.requests.filter(({ method }) => method === "input.key").map(({ params }) => [params.key, params.phase]), [["a", "down"], ["a", "up"]]);
});

test("S0b closes the project and waits for the exit of each WebContent process of a view page or a document region", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-state-s0b");
  const context = await prepareState(s, "S0b", prepareDeps());
  await server.played;
  assert.deepEqual(received(server), S1_STEPS.slice(0, 1).concat(S1_STEPS.slice(2, 4), [
    ["run", "w1", "core.project.close", { id: "p1" }, undefined],
    ["diagnostics.process.exit", "w1"],
    ["diagnostics.process.exit", "w1"],
  ]));
  assert.deepEqual(server.requests.filter(({ method }) => method === "diagnostics.process.exit").map(({ params }) => params.pid), [902, 903]);
  assert.deepEqual(context, { state: "S0b", windows: ["w1"], footprints: "settled", exited: [902, 903] });
  const kept = await play(t, "measure-state-s0b-kept");
  await assert.rejects(prepareState(kept.s, "S0b", prepareDeps()), /core.project.close kept the project p1 \(closed false\)/);
  await kept.server.played;
});

test("S9 places a second library window over the window of S1 and requires occluded true", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-state-s9");
  const context = await prepareState(s, "S9", prepareDeps(), S1_PLUGINS);
  await server.played;
  assert.deepEqual(received(server).slice(S1_STEPS.length), [
    ["run", "w1", "core.window.new", {}, undefined],
    ["run", "w2", "host.window.resize", { width: 1320, height: 880 }, undefined],
    ["run", "w2", "host.window.move", { x: 40, y: -10 }, undefined],
  ]);
  assert.deepEqual(context.windows, ["w1", "w2"]);
});

test("S9 fails when the second window does not cover the window of S1", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-state-s9-uncovered");
  await assert.rejects(prepareState(s, "S9", prepareDeps(), S1_PLUGINS), /the second window did not cover window w1/);
  await server.played;
});

test("S11 opens a second project window beside the window of S1", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-state-s11");
  const context = await prepareState(s, "S11", prepareDeps({ projectRoot: "/var/tester/projects/S11" }), S1_PLUGINS);
  await server.played;
  assert.deepEqual(received(server).slice(S1_STEPS.length), [
    ["run", "w1", "core.window.new", {}, undefined],
    ["run", "w2", "core.project.open", { root: "/var/tester/projects/S11" }, undefined],
    ["run", "w2", "host.window.resize", { width: 1200, height: 760 }, undefined],
    ["run", "w2", "host.window.move", { x: 1300, y: 50 }, undefined],
  ]);
  assert.deepEqual(context.windows, ["w1", "w2"]);
});

test("S12 makes one layout draw fail and waits for its error line in the application log", { timeout: 30000 }, async (t) => {
  const { s, server, configDir } = await play(t, "measure-state-s12");
  const log = join(configDir, "logs", "host-1-10.jsonl");
  mkdirSync(join(configDir, "logs"));
  writeFileSync(log, "");
  // The host writes the error line of the fault after the request that causes it.
  server.events.on("request", ({ method }) => {
    if (method === "diagnostics.layout.fail") {
      appendFileSync(log, `${JSON.stringify({ level: "error", layer: "workbench", seq: 1, event: "workbench.record.error", fields: { where: "surface presentation failed", text: "diagnostic layout fault" } })}\n`);
    }
  });
  const context = await prepareState(s, "S12", prepareDeps(), S1_PLUGINS);
  await server.played;
  assert.deepEqual(received(server).slice(S1_STEPS.length), [
    ["diagnostics.layout.fail", "w1"],
    ["run", "w1", "host.window.resize", { width: 1160, height: 760 }, undefined],
    ["run", "w1", "host.window.resize", { width: 1200, height: 760 }, undefined],
  ]);
  assert.deepEqual(Object.keys(context.faultLog), ["host-1-10.jsonl"]);
  assert.equal(context.faultLog["host-1-10.jsonl"].offset, 0, "the position is the end of the log before the request");
});

test("S15 opens the settings window of S1", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-state-s15");
  await prepareState(s, "S15", prepareDeps(), S1_PLUGINS);
  await server.played;
  assert.deepEqual(received(server).slice(S1_STEPS.length), [["run", "w1", "core.settings.open", {}, undefined]]);
});

test("the blank page of S1 is a loopback page that is titled blank and ends with its server", { timeout: 30000 }, async () => {
  const blank = await serveBlank();
  try {
    assert.match(blank.url, /^http:\/\/127\.0\.0\.1:\d+\/blank$/);
    const response = await fetch(blank.url);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await response.text(), "<!doctype html><title>blank</title>");
  } finally {
    await blank.close();
  }
});

test("the processes of an application are its host, its sidecars and the WebKit services of the launchd domain of its host, read from the recorded process table", () => {
  const configDir = PS.configDir;
  const host = applicationHost({ table: TABLE, configDir, realPath: configDir });
  assert.deepEqual(host, { pid: PIDS.host }, "the tools that carry --config-dir and the host launched through the link are no host of this folder");
  const webkit = domainRows("launchctl-print-all-services", configDir);
  assert.deepEqual(applicationRowsOf({ table: TABLE, configDir, realPath: configDir, host, webkit }), [
    { role: "host", pid: PIDS.host, attribution: "config-dir argument" },
    { role: "sidecar probe", pid: PIDS.sidecar, attribution: "executable path" },
    { role: "webkit webcontent", pid: 1648, attribution: "launchd domain" },
    { role: "webkit gpu", pid: 1413, attribution: "launchd domain" },
    { role: "webkit networking", pid: 1635, attribution: "launchd domain" },
  ]);
});

test("the host and the sidecar of a data folder that is named through a symbolic link are found by the real path of the folder", () => {
  const { linkedConfigDir, linkedRealPath } = PS;
  const host = applicationHost({ table: TABLE, configDir: linkedConfigDir, realPath: linkedRealPath });
  assert.deepEqual(host, { pid: PIDS.linkedHost });
  assert.deepEqual(applicationRowsOf({ table: TABLE, configDir: linkedConfigDir, realPath: linkedRealPath, host, webkit: [] }), [
    { role: "host", pid: PIDS.linkedHost, attribution: "config-dir argument" },
    { role: "sidecar worker", pid: PIDS.linkedSidecar, attribution: "executable path" },
  ]);
});

test("a data folder without a host process in the process table is an error that names the folder", () => {
  const withoutHost = TABLE.filter(({ pid }) => pid !== PIDS.host);
  assert.throws(() => applicationHost({ table: withoutHost, configDir: PS.configDir, realPath: PS.configDir }),
    new RegExp(`^Error: host of ${PS.configDir}: no host process has --config-dir ${PS.configDir}$`));
});

test("the wait for the counts is longer than the time a count of the gate waits for a write", () => {
  const source = readFileSync(fileURLToPath(new URL("../../packages/sok/go/src/event_log.go", import.meta.url)), "utf8");
  assert.match(source, /const gatedWait = time\.Minute\n/);
  assert.ok(COUNT_WAIT_MS > 60000);
});

test("the records of the interval are the lines that the event logs gained, in a file that appeared as well", () => {
  const folder = mkdtempSync(join(tmpdir(), "records-over-"));
  try {
    mkdirSync(join(folder, "logs"));
    writeFileSync(join(folder, "logs", "host-1-1.jsonl"), "{}\n{}\n");
    writeFileSync(join(folder, "logs", "host-1-1.stderr"), "not counted\n");
    const before = logLineCounts(folder);
    assert.equal(recordsOver(before, logLineCounts(folder)), 0);
    appendFileSync(join(folder, "logs", "host-1-1.jsonl"), "{}\n");
    writeFileSync(join(folder, "logs", "files-2-2.jsonl"), "{}\n{}\n");
    assert.equal(recordsOver(before, logLineCounts(folder)), 3);
  } finally {
    rmSync(folder, { recursive: true });
  }
});

/** The window marks of a measurement of two windows of the mygo host, before and after the cpu interval. */
function marksOfTwo({ frames = [[340, 340], [512, 513]], commandBuffers = [[338, 338], [500, 502]] } = {}) {
  const mark = (index) => [
    { window: "w1", occluded: false, active: true, frames: frames[0][index], commandBuffers: commandBuffers[0][index], scale: 2, refreshRate: 120, content: { width: 1200, height: 760 } },
    { window: "w2", occluded: false, active: true, frames: frames[1][index], commandBuffers: commandBuffers[1][index], scale: 2, refreshRate: 120, content: { width: 1200, height: 760 } },
  ];
  return { before: mark(0), after: mark(1) };
}

const CPU_BEFORE = cpuSecondsOf(recorded("ps-cpu-before"));
const CPU_AFTER = cpuSecondsOf(recorded("ps-cpu-after"));
/** The interval, in seconds, of the two recorded CPU readings: the recording of the readings states it. */
const CPU_SECONDS = 2;

/** A measured entry of a process of the recording: the row and the place that names it in an error. */
const entry = (role, pid, name) => ({ row: { role, pid }, where: `${name} ${role} (pid ${pid})` });

test("the cpu readings of ps are the cpu seconds of every process, and a failing ps is an error that names the command", () => {
  assert.equal(CPU_BEFORE.size, 8);
  assert.equal(CPU_AFTER.size, 7, "the process that ended is not in the reading after the interval");
  assert.equal(CPU_BEFORE.get(PIDS.busy), 1.02);
  assert.equal(CPU_AFTER.get(PIDS.busy), 3.03);
  assert.equal(CPU_BEFORE.get(PIDS.ender), 0);
  assert.throws(() => cpuSecondsOf(recorded("ps-failure")), /^Error: ps -axo pid=,time= exited with 1: ps: bogus: keyword not found/);
  assert.throws(() => outputOf("ps", ["-axo", "pid=,bogus="], recorded("ps-failure")), /^Error: ps -axo pid=,bogus= exited with 1: ps: bogus: keyword not found/);
});

test("the cpu figures of a process are its cpu seconds over the interval, and a process of the application that ends is an error", () => {
  const measured = [entry("host", PIDS.host, PS.configDir), entry("sidecar probe", PIDS.sidecar, PS.configDir), entry("sidecar busy", PIDS.busy, PS.configDir)];
  const result = cpuFigures({ measured, foreign: new Set(), cpuBefore: CPU_BEFORE, cpuAfter: CPU_AFTER, elapsed: CPU_SECONDS });
  assert.deepEqual(result, { errors: [], ended: new Set() });
  const [host, , busy] = measured.map(({ row }) => row);
  assert.equal(host.cpuSeconds, 0);
  assert.equal(Number(busy.cpuSeconds.toFixed(2)), 2.01);
  assert.equal(Number(busy.cpuPercent.toFixed(2)), 100.5);
  const ending = [entry("sidecar probe", PIDS.ender, PS.configDir)];
  assert.deepEqual(cpuFigures({ measured: ending, foreign: new Set(), cpuBefore: CPU_BEFORE, cpuAfter: CPU_AFTER, elapsed: CPU_SECONDS }),
    { errors: [`${PS.configDir} sidecar probe (pid ${PIDS.ender}): pid is not in the process table at both cpu reads`], ended: new Set() });
  assert.deepEqual([ending[0].row.cpuSeconds, ending[0].row.cpuPercent], [null, null]);
});

test("a decrease of the cpu time of a process is an error that names the process", () => {
  const measured = [entry("sidecar busy", PIDS.busy, PS.configDir)];
  assert.deepEqual(cpuFigures({ measured, foreign: new Set(), cpuBefore: CPU_AFTER, cpuAfter: CPU_BEFORE, elapsed: CPU_SECONDS }),
    { errors: [`${PS.configDir} sidecar busy (pid ${PIDS.busy}): cpu time decreased from 3.03 to 1.02`], ended: new Set() });
});

test("a process of no application that ends between the cpu reads leaves the list without an error", () => {
  const measured = [entry("webkit networking", PIDS.ender, "unattributed"), entry("host", PIDS.host, PS.configDir)];
  const result = cpuFigures({ measured, foreign: new Set([PIDS.ender]), cpuBefore: CPU_BEFORE, cpuAfter: CPU_AFTER, elapsed: CPU_SECONDS });
  assert.deepEqual(result, { errors: [], ended: new Set([PIDS.ender]) });
  assert.equal(measured[1].row.cpuSeconds, 0, "the other processes keep their figures");
});

test("the WebKit processes that no application claims are the unattributed rows, and pgrep without a match or with an invalid pattern is judged by its exit", () => {
  const gpu = webkitPidsOf("GPU", recorded("pgrep-gpu"));
  const networking = webkitPidsOf("Networking", recorded("pgrep-networking"));
  assert.deepEqual(gpu, [1413, 1638, 90524].map((pid) => ({ pid, role: "webkit gpu" })));
  assert.deepEqual(networking, [1635, 76149, 90525].map((pid) => ({ pid, role: "webkit networking" })));
  assert.deepEqual(unattributedRows([...gpu, ...networking], new Set([1413, 1635, 1638])), [
    { role: "webkit gpu", pid: 90524, attribution: "unattributed" },
    { role: "webkit networking", pid: 76149, attribution: "unattributed" },
    { role: "webkit networking", pid: 90525, attribution: "unattributed" },
  ]);
  assert.deepEqual(webkitPidsOf("GPU", recorded("pgrep-none")), [], "pgrep exits with 1 when no process matches");
  assert.throws(() => webkitPidsOf("GPU", recorded("pgrep-invalid")), /^Error: pgrep failed: pgrep: Cannot compile regular expression/);
});

test("a footprint reading is the footprint and the peak of the recorded output, and a process that is gone is an error that names it", () => {
  const running = recorded("footprint-running");
  assert.deepEqual(footprintOfResult(running.pid, running), { bytes: 12027560, peakBytes: 12027560 });
  const ended = recorded("footprint-ended");
  assert.throws(() => footprintOfResult(ended.pid, ended), new RegExp(`^Error: footprint -p ${ended.pid} exited with 66: footprint: Unable to find pid for process matching '${ended.pid}'`));
});

test("a process of no application whose footprint cannot be read ended when the process table at the end does not hold it, and failed when it does", () => {
  const ended = recorded("footprint-ended");
  let failure;
  try {
    footprintOfResult(ended.pid, ended);
  } catch (error) {
    failure = `unattributed webkit networking (pid ${ended.pid}): ${error.message}`;
  }
  const unread = new Map([[ended.pid, failure]]);
  assert.deepEqual(unreadOutcome({ unread, last: CPU_AFTER }), { failures: [], ended: [ended.pid] }, "the table at the end has no such process");
  const outcome = unreadOutcome({ unread, last: CPU_BEFORE });
  assert.equal(outcome.failures.length, 1);
  assert.match(outcome.failures[0], new RegExp(`unattributed webkit networking \\(pid ${ended.pid}\\): footprint -p ${ended.pid} exited with 66`));
  assert.deepEqual(outcome.ended, [], "the table still holds the process, so it has no footprint although it runs");
});

/** One application of measureApps of the mygo host: the host, a sidecar, a document process and the WebKit GPU and networking services. */
function measuredApp({ after = false } = {}) {
  const rows = [
    { role: "host", pid: 10, bytes: 80 * MB, peakBytes: 96 * MB, cpuSeconds: 0.12 },
    { role: "sidecar probe", pid: 11, bytes: 6 * MB, peakBytes: 7 * MB, cpuSeconds: 0.02 },
    { role: "document tab-2/doc-1", pid: 902, bytes: 40 * MB, peakBytes: 41 * MB, cpuSeconds: 0.3 },
    { role: "webkit gpu", pid: 300, bytes: 20 * MB, peakBytes: 21 * MB, cpuSeconds: 0.1 },
    { role: "webkit networking", pid: 301, bytes: 4 * MB, peakBytes: 5 * MB, cpuSeconds: 0.01 },
  ].map((row) => (after ? { ...row, bytesAfter: row.bytes + 2 * MB } : row));
  return { configDir: MYGO, windows: ["w1", "w2"], rows, totals: totalsOf(rows) };
}

test("the B3 measurements of app-usage are the host and application figures, the WebKit processes and the change of the frame counters", () => {
  const measured = usageMeasurements({ app: measuredApp(), marks: marksOfTwo() });
  assert.deepEqual(Object.keys(measured).toSorted(), [
    "applicationCpuSeconds", "applicationFootprintKb", "applicationPeakFootprintKb", "commandBuffers", "frames", "hostCpuSeconds", "hostFootprintKb", "sidecarCpuSeconds",
    "sidecarFootprintKb", "webContentProcesses", "webKitProcesses",
  ]);
  assert.equal(measured.hostCpuSeconds, 0.12);
  assert.equal(Number(measured.applicationCpuSeconds.toFixed(2)), 0.53);
  assert.equal(measured.sidecarCpuSeconds, 0.02);
  assert.deepEqual([measured.hostFootprintKb, measured.applicationFootprintKb, measured.sidecarFootprintKb, measured.applicationPeakFootprintKb],
    [80 * 1024, 144 * 1024, 6 * 1024, 163 * 1024]);
  assert.deepEqual([measured.webKitProcesses, measured.webContentProcesses, measured.frames, measured.commandBuffers], [3, 1, 1, 2]);
});

test("the B3 measurements add the footprint after the pointer move, the error lines of the fault and the pointer move p90", () => {
  const measured = usageMeasurements({
    app: measuredApp({ after: true }), marks: marksOfTwo(), faultLines: 1, gesture: { window: "w1", frameRecords: 4, moves: 4, p90Ms: 6, framesChange: 4 },
  });
  assert.equal(measured.applicationFootprintAfterKb, 152 * 1024);
  assert.equal(measured.errorLines, 1);
  assert.equal(measured.pointerMoveP90Ms, 6);
  assert.equal("pointerMoveP90Ms" in usageMeasurements({ app: measuredApp(), marks: marksOfTwo(), gesture: null }), false);
});

test("a host whose host.window reports no frame counters has no frames and commandBuffers measurements, and a partial counter fails", () => {
  const none = usageMeasurements({ app: measuredApp(), marks: marksOfTwo({ frames: [[null, null], [null, null]], commandBuffers: [[null, null], [null, null]] }) });
  assert.equal("frames" in none, false);
  assert.equal("commandBuffers" in none, false);
  assert.throws(() => usageMeasurements({ app: measuredApp(), marks: marksOfTwo({ frames: [[340, 340], [null, 7]] }) }),
    /window w2 reports frames null before the first and 7 after the last cpu reading/);
  const missing = { before: marksOfTwo().before, after: marksOfTwo().after.slice(0, 1) };
  assert.throws(() => usageMeasurements({ app: measuredApp(), marks: missing }), /window w2 has no mark after the last cpu reading/);
});

test("the processes of the windows of an application are its listing with the page and document rows of each window, one row per pid", () => {
  const configDir = PS.configDir;
  const host = applicationHost({ table: TABLE, configDir, realPath: configDir });
  const listed = applicationRowsOf({ table: TABLE, configDir, realPath: configDir, host, webkit: domainRows("launchctl-print-all-services", configDir) });
  const statuses = [
    { ...mygoWindow({ pageProcess: 1648, documents: [] }), window: "w1" },
    { ...mygoWindow({ documents: [{ surface: "tab-2", document: "doc-1", process: 903 }, { surface: "tab-3", document: "doc-2", process: 0 }] }), window: "w2" },
  ];
  assert.deepEqual(windowRowsOf({ configDir, listed, statuses }), {
    rows: [
      { role: "host", pid: PIDS.host, attribution: "config-dir argument" },
      { role: "sidecar probe", pid: PIDS.sidecar, attribution: "executable path" },
      { role: "page w1", pid: 1648, attribution: "host.window" },
      { role: "document tab-2/doc-1", pid: 903, attribution: "host.window" },
      { role: "webkit gpu", pid: 1413, attribution: "launchd domain" },
      { role: "webkit networking", pid: 1635, attribution: "launchd domain" },
    ],
    errors: [`document tab-3/doc-2 of window w2 of ${configDir}: no process (0)`],
  });
});

test("the B3 keys of app-usage end in their unit, are listed for each trace state, and a measurement with every figure holds every key of TRACE 0 and 1", () => {
  const RUN = [
    "hostCpuSeconds", "applicationCpuSeconds", "sidecarCpuSeconds", "hostFootprintKb", "applicationFootprintKb", "sidecarFootprintKb",
    "applicationFootprintAfterKb", "applicationPeakFootprintKb", "webKitProcesses", "webContentProcesses", "frames", "commandBuffers",
    "errorLines",
  ];
  assert.deepEqual(B3_MEASUREMENTS, { 0: RUN, 1: RUN, "frame-records": ["pointerMoveP90Ms"] });
  assert.ok(Object.isFrozen(B3_MEASUREMENTS) && Object.values(B3_MEASUREMENTS).every(Object.isFrozen));
  const measured = usageMeasurements({ app: measuredApp({ after: true }), marks: marksOfTwo(), faultLines: 1, gesture: null });
  assert.deepEqual(Object.keys(measured).toSorted(), B3_MEASUREMENTS[0].toSorted());
});

/** The classes of the log policy in force of a B3 test: the default policy with the class frame at debug. */
const POLICY = { lifecycle: "error", input: "error", call: "error", io: "error", frame: "debug" };

test("a pointer output holds the keys of one trace state: the cpu and footprint keys under TRACE 0 or 1, pointerMoveP90Ms alone under frame-records", () => {
  const measurement = {
    apps: [measuredApp({ after: true })],
    marks: {
      before: [{ configDir: MYGO, trace: false, policy: POLICY, windows: marksOfTwo().before }],
      after: [{ configDir: MYGO, trace: false, policy: POLICY, windows: marksOfTwo().after }],
    },
  };
  const gesture = { window: "w1", frameRecords: 4, moves: 4, p90Ms: 6, framesChange: 4 };
  for (const trace of [0, 1]) {
    const output = usageOutput({ options: { trace, step: "pointer" }, measurement, gesture });
    assert.equal("pointerMoveP90Ms" in output.measurements, false);
    assert.deepEqual(Object.keys(output.measurements).filter((key) => !B3_MEASUREMENTS[trace].includes(key)), []);
    assert.equal(output.measurements.applicationFootprintAfterKb, 152 * 1024);
    assert.equal(output.conditions.traceState, trace === 1);
  }
  const records = usageOutput({ options: { trace: "frame-records", step: "pointer" }, measurement, gesture });
  assert.deepEqual(Object.keys(records.measurements), B3_MEASUREMENTS["frame-records"]);
  assert.deepEqual(records, {
    measurements: { pointerMoveP90Ms: 6 },
    conditions: { refreshRate: 120, refreshRates: { w1: 120, w2: 120 }, backingScale: 2, traceState: false, logPolicy: POLICY, window: { width: 1200, height: 760 }, occluded: false, active: true },
  });
  assert.throws(() => usageOutput({ options: { trace: "frame-records", step: "pointer" }, measurement, gesture: null }),
    /the pointer output under the trace state frame-records is pointerMoveP90Ms, which a window with a main page has not/);
});

test("TRACE frame-records is the trace state of the pointer step and needs --step pointer", () => {
  const base = ["--sok", "/b/sok", "--config-dir", MYGO, "--trace", "frame-records"];
  assert.equal(parseOptions([...base, "--step", "pointer"]).trace, "frame-records");
  assert.throws(() => parseOptions(base), /TRACE frame-records is the trace state of the U7 records of --step pointer, which was not given/);
});

test("the B3 output of app-usage takes its conditions from b3-out with the performance switch of the trace state", () => {
  const measurement = {
    apps: [measuredApp()],
    marks: {
      before: [{ configDir: MYGO, trace: false, policy: POLICY, windows: marksOfTwo().before }],
      after: [{ configDir: MYGO, trace: false, policy: POLICY, windows: marksOfTwo().after }],
    },
  };
  const output = usageOutput({ options: { trace: 0 }, measurement, faultLines: undefined, gesture: undefined });
  assert.deepEqual(output.conditions, { refreshRate: 120, refreshRates: { w1: 120, w2: 120 }, backingScale: 2, traceState: false, logPolicy: POLICY, window: { width: 1200, height: 760 }, occluded: false, active: true });
  assert.equal(output.measurements.hostCpuSeconds, 0.12);
  assert.equal(usageOutput({ options: { trace: 1 }, measurement }).conditions.traceState, true);
  const covered = { ...measurement, marks: { ...measurement.marks, after: [{ ...measurement.marks.after[0], windows: marksOfTwo().after.map((window) => ({ ...window, occluded: true })) }] } };
  assert.equal(usageOutput({ options: { trace: 0 }, measurement: covered }).conditions.occluded, true, "the output states a window covered at the end");
  const mark = (name, members) => ({ ...measurement, marks: { ...measurement.marks, [name]: [{ ...measurement.marks[name][0], windows: marksOfTwo()[name].map((window) => ({ ...window, ...members })) }] } });
  assert.equal(usageOutput({ options: { trace: 0 }, measurement: mark("before", { active: false }) }).conditions.active, false, "the output states an application that was not active at the start");
  assert.equal(usageOutput({ options: { trace: 0 }, measurement: mark("after", { active: false }) }).conditions.active, false, "the output states an activation that ended");
  assert.equal(usageOutput({ options: { trace: 0 }, measurement: mark("before", { occluded: true }) }).conditions.occluded, true, "the output states a window covered at the start");
  const folder = mkdtempSync(join(tmpdir(), "b3-usage-"));
  try {
    writeB3Out(join(folder, "S1.json"), output);
    assert.deepEqual(readB3Out(join(folder, "S1.json")), output);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  const mixed = { ...measurement, marks: { ...measurement.marks, before: [{ ...measurement.marks.before[0], windows: [marksOfTwo().before[0], { ...marksOfTwo().before[1], scale: 1 }] }] } };
  assert.throws(() => usageOutput({ options: { trace: 0 }, measurement: mixed }), /window w2 reports scale 1, not scale 2 of window w1/);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";
import { Session } from "@soksak/window-check/app.mjs";

import { readB3Out, writeB3Out } from "../b3-out.mjs";

import { B3_MEASUREMENTS, formatReport, frameCost, readRedrawConditions, redrawConditions, regionCost, readRegion, requireUncovered, parseOptions, parseWindowServer, prepareRedraw, presentedFramesOf, readCovered, redrawMeasurements, requireRows, screenText, coveredWaitMs } from "../measure-terminal-redraw.mjs";

/** The session of the window w1 on a client that is connected to the player of the endpoint case `name`; closing the player fails when the case was not played. */
async function play(t, name) {
  const server = await startCasePlayer(name);
  const configDir = mkdtempSync(join(tmpdir(), "soksak-measure-redraw-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const s = new Session({ name: "fixture", configDir }, client);
  s.window = "w1";
  return { s, server };
}

test("the text of a screen joins the characters of each row and counts an empty cell as spaces of its width", () => {
  assert.equal(screenText([[{ ch: "a", width: 1 }, { width: 1 }, { ch: "b", width: 1 }], [{ ch: "한", width: 2 }, { width: 0 }]]), "a b\n한");
  assert.throws(() => screenText(null), /terminal screen is not a list of rows/);
});

test("the options require the application, the plugin, the rows and the trace state, a rate from 1 to 120 and no surface", () => {
  const base = ["--sok", "/bin/sok", "--config-dir", "/tmp/c", "--plugin", "rasterprobe", "--rows", "20", "--trace", "0"];
  assert.deepEqual(parseOptions(base),
    { sok: "/bin/sok", configDir: "/tmp/c", plugin: "rasterprobe", rows: 20, rate: 20, interval: 10, trace: 0, b3Out: null, json: false });
  assert.equal(parseOptions([...base, "--b3-out", "/tmp/b3/S2.json"]).b3Out, "/tmp/b3/S2.json");
  assert.throws(() => parseOptions([...base, "--b3-out", "S2.json"]), /--b3-out must be an absolute path \(S2.json\)/);
  assert.throws(() => parseOptions(["--sok", "/bin/sok", "--config-dir", "/tmp/c", "--rows", "1", "--trace", "0"]), /required options/);
  assert.throws(() => parseOptions(["--sok", "s", "--config-dir", "rel", "--plugin", "p", "--rows", "1", "--trace", "0"]), /--config-dir must be an absolute path \(rel\)/);
  assert.throws(() => parseOptions([...base, "--rate", "121"]), /--rate must be an integer from 1 to 120 \(121\)/);
  assert.throws(() => parseOptions([...base.slice(0, 6), "--rows", "0", "--trace", "0"]), /--rows must be a positive integer \(0\)/);
  assert.throws(() => parseOptions(base.slice(0, 8)), /TRACE must be 0 or 1, not set/);
  assert.throws(() => parseOptions([...base, "--surface", "tab-a"]), /Unknown option '--surface'/);
});

/** The host.window of the project window of the measurement with the image region of tab-1. */
function redrawWindow(overrides = {}) {
  return {
    frame: { x: 40, y: 60, width: 760, height: 642 },
    content: { x: 0, y: 28, width: 760, height: 614 },
    occluded: false,
    active: true,
    pageProcess: null,
    frames: 900,
    commandBuffers: 899,
    regions: [{ surface: "tab-1", name: "screen", presentedFrames: 120 }, { surface: "tab-9", name: "screen", presentedFrames: 5 }],
    ...overrides,
  };
}

test("the terminal must hold the rows of the fixture and the row of its cursor without scrolling", () => {
  const screen = (rows) => Array.from({ length: rows }, () => [{ ch: "a", width: 1 }]);
  requireRows(screen(36), 20, "tab-1");
  requireRows(screen(21), 20, "tab-1");
  assert.throws(() => requireRows(screen(20), 20, "tab-1"), /the terminal of tab-1 has 20 rows; the fixture rewrites 20 rows above the row of its cursor/);
});

test("the presented frames of the tab are the presentedFrames of its one image region", () => {
  assert.equal(presentedFramesOf(redrawWindow(), "tab-1", "w2"), 120);
  assert.throws(() => presentedFramesOf(redrawWindow({ regions: [] }), "tab-1", "w2"), /window w2 has 0 image regions of tab-1, not 1/);
  assert.throws(() => presentedFramesOf(redrawWindow({ regions: [{ surface: "tab-1", name: "screen" }] }), "tab-1", "w2"),
    /the image region tab-1\/screen of window w2 reports presentedFrames undefined, not a count/);
});

test("the cpu time of each process is divided by the frames that the region presented over the interval", () => {
  const rows = [
    { role: "host", pid: 10, cpuSeconds: 0.9 },
    { role: "sidecar probe", pid: 11, cpuSeconds: 0.3 },
    { role: "webkit gpu", pid: 300, cpuSeconds: null },
  ];
  const totals = { application: { cpuSeconds: 0.9 }, sidecars: { cpuSeconds: 0.3 }, total: { cpuSeconds: 1.2 } };
  assert.deepEqual(frameCost({ rows, totals, presented: 300, seconds: 10 }), {
    presented: 300,
    framesPerSecond: 30,
    rows: [
      { role: "host", pid: 10, cpuSeconds: 0.9, msPerFrame: 3 },
      { role: "sidecar probe", pid: 11, cpuSeconds: 0.3, msPerFrame: 1 },
      { role: "webkit gpu", pid: 300, cpuSeconds: null, msPerFrame: null },
    ],
    totals: { application: 3, sidecars: 1, total: 4 },
  });
  assert.throws(() => frameCost({ rows, totals, presented: 0, seconds: 10 }), /the region presented no frame over the interval of 10 s/);
});

test("the B3 measurements of the redraw are the cpu milliseconds per presented frame, the frame rate and the presented frames", () => {
  const rows = [{ role: "host", pid: 10, cpuSeconds: 0.9 }, { role: "sidecar probe", pid: 11, cpuSeconds: 0.3 }];
  const totals = { application: { cpuSeconds: 0.9 }, sidecars: { cpuSeconds: 0.3 }, total: { cpuSeconds: 1.2 } };
  assert.deepEqual(redrawMeasurements(frameCost({ rows, totals, presented: 300, seconds: 10 })),
    { hostCpuPerFrameMs: 3, applicationCpuPerFrameMs: 3, sidecarCpuPerFrameMs: 1, framesPerSecond: 30, presentedFrames: 300 });
  assert.deepEqual(B3_MEASUREMENTS, ["hostCpuPerFrameMs", "applicationCpuPerFrameMs", "sidecarCpuPerFrameMs", "framesPerSecond", "presentedFrames"]);
  assert.ok(Object.isFrozen(B3_MEASUREMENTS));
  assert.deepEqual(Object.keys(redrawMeasurements(frameCost({ rows, totals, presented: 300, seconds: 10 }))), [...B3_MEASUREMENTS]);
});

const ROOT = "/var/tester/redraw-project";

test("the measurement opens one tab of the plugin in a new project window of 760 by 614 points", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-redraw-prepare");
  const prepared = await prepareRedraw(s, "rasterprobe", ROOT);
  await server.played;
  assert.deepEqual(server.requests.filter(({ method }) => method === "command.run").map(({ params }) => [params.window, params.name, params.params]), [
    ["w1", "core.window.new", {}],
    ["w2", "core.project.open", { root: ROOT }],
    ["w2", "host.window.resize", { width: 760, height: 614 }],
    ["w2", "core.card.add-tab", { card: "c1", plugin: "rasterprobe" }],
    ["w2", "core.tab.close", { tab: "t-old" }],
  ]);
  assert.equal(prepared.s.window, "w2");
  assert.deepEqual([prepared.tab, prepared.project], ["tab-1", "p2"]);
});

test("the measurement fails with the entry that the tab of the plugin did not register", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-redraw-prepare-entry-missing");
  await assert.rejects(prepareRedraw(s, "rasterprobe", ROOT), (error) => error.message === "the rasterprobe tab tab-1 did not register status rasterprobe.screen");
  await server.played;
});

test("the measurement stops at a covered window before it opens the tab, because a covered region shows no screen of the fixture", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-redraw-prepare-covered");
  await assert.rejects(prepareRedraw(s, "rasterprobe", ROOT), /window w2 is covered/);
  await server.played;
  assert.equal(server.requests.some(({ params }) => params.name === "core.card.add-tab"), false);
});

test("the region read returns the presentedFrames of the tab and the window value", { timeout: 30000 }, async (t) => {
  const read = await play(t, "measure-region-read");
  read.s.window = "w2";
  const reading = await readRegion(read.s, "tab-1");
  assert.equal(reading.presented, 120);
  assert.deepEqual(reading.status.content, { x: 0, y: 28, width: 760, height: 614 });
  await read.server.played;
});

test("the region read fails while the window is occluded", { timeout: 30000 }, async (t) => {
  const covered = await play(t, "measure-region-occluded");
  covered.s.window = "w2";
  await assert.rejects(readRegion(covered.s, "tab-1"), /window w2 reports occluded true; the measurement requires occluded false/);
  await covered.server.played;
});

test("the cost of the region divides the cpu time by the presented frames between the marks and adds the cpu time of the window server", () => {
  const measurement = {
    seconds: 10,
    marks: { before: { presented: 120, status: { content: { x: 0, y: 28, width: 760, height: 614 } } }, after: { presented: 420 } },
    apps: [{ rows: [{ role: "host", pid: 10, cpuSeconds: 1.5 }], totals: { application: { cpuSeconds: 1.5 }, sidecars: { cpuSeconds: 0 }, total: { cpuSeconds: 1.5 } } }],
    errors: [],
  };
  const result = regionCost({ measurement, first: { pid: 77, seconds: 100 }, last: { pid: 77, seconds: 100.9 } });
  assert.equal(result.cost.presented, 300);
  assert.equal(result.cost.totals.total, 5);
  assert.equal(result.cost.windowServer.pid, 77);
  assert.equal(result.cost.windowServer.cpuSeconds.toFixed(2), "0.90");
  assert.equal(result.cost.windowServer.msPerFrame.toFixed(2), "3.00");
  assert.deepEqual(result.status.content, { x: 0, y: 28, width: 760, height: 614 });
});

test("a window that reported occluded true during the interval fails the measurement", () => {
  requireUncovered("w2", null);
  assert.throws(() => requireUncovered("w2", redrawWindow({ occluded: true })), /window w2 reported occluded true during the interval/);
});

test("the watch for a covered window waits a second or the rest of the watch and ends when the watch is over, because a status watch relays every presented frame", () => {
  const wait = (now) => coveredWaitMs({ startedAt: 4000, now: 4000 + now, ms: 2500 });
  assert.deepEqual([0, 1000, 2000, 2400, 2500, 2600].map(wait), [1000, 1000, 500, 100, 0, 0], "the readings at 1 s, at 2 s and at the end of 2.5 s");
  assert.equal(coveredWaitMs({ startedAt: 0, now: 1004, ms: 10000 }), 1000, "a wait is at most a second");
  assert.throws(() => coveredWaitMs({ startedAt: 4000, now: 3999, ms: 2500 }), /the instant 3999 ms is before the instant 4000 ms/);
});

test("a reading of a window that never reports occluded true is no covered status", { timeout: 30000 }, async (t) => {
  const never = await play(t, "measure-covered-never");
  never.s.window = "w2";
  for (let reading = 0; reading < 3; reading++) assert.equal(await readCovered({ s: never.s }), null);
  await never.server.played;
});

test("a reading of a covered window is its host.window value, and the second reading of the case is the first that reports occluded true", { timeout: 30000 }, async (t) => {
  const covered = await play(t, "measure-covered-second-read");
  covered.s.window = "w2";
  assert.equal(await readCovered({ s: covered.s }), null);
  assert.equal((await readCovered({ s: covered.s })).occluded, true);
  await covered.server.played;
});

test("the window server is the process of that name in the process table, and a table without it is an error", () => {
  const table = "  101  0:01.20 /usr/libexec/logd\n77164 223:45.54 /System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer\n  202  0:00.10 /tmp/WindowServer-copy\n";
  assert.deepEqual(parseWindowServer(table), { pid: 77164, seconds: 223 * 60 + 45.54 });
  assert.throws(() => parseWindowServer("  101  0:01.20 /usr/libexec/logd\n"), /the process table has no window server/);
});

test("the report adds the window server to the sums of the application, because the screen of the terminal costs it too", () => {
  const rows = [{ role: "host", pid: 10, cpuSeconds: 1.5 }];
  const totals = { application: { cpuSeconds: 1.5 }, sidecars: { cpuSeconds: 0.3 }, total: { cpuSeconds: 1.8 } };
  const cost = { ...frameCost({ rows, totals, presented: 300, seconds: 10 }), windowServer: { pid: 77, cpuSeconds: 0.9, msPerFrame: 3 } };
  const lines = formatReport({ plugin: "rasterprobe", rows: 20, rate: 30, window: "w2", tab: "tab-1", seconds: 10, cost }).split("\n");
  assert.deepEqual(lines.slice(-5), [
    "application without sidecars 5.00 ms/frame",
    "sidecars 1.00 ms/frame",
    "total 6.00 ms/frame",
    "window server 77 0.900 3.00 the whole screen",
    "total with the window server 9.00 ms/frame",
  ]);
});

test("the fixture draws a start line, frames of the given rows and an end line with the number of frames", { timeout: 10000 }, () => {
  const fixture = fileURLToPath(new URL("../fixtures/status-redraw.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [fixture, "20", "0.3", "20"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^status-redraw start rate=20 rows=20\n/);
  const end = /status-redraw end frames=(\d+)\n$/.exec(run.stdout);
  assert.ok(end && Number(end[1]) >= 1, `the fixture ended without its frame count: ${JSON.stringify(run.stdout.slice(-60))}`);
  const frame = run.stdout.slice(run.stdout.indexOf("\x1b[20A"), run.stdout.indexOf("\x1b[20A", run.stdout.indexOf("\x1b[20A") + 1));
  assert.equal(frame.split("\r\x1b[2K").length - 1, 20, `a frame did not rewrite 20 rows: ${JSON.stringify(frame)}`);
  const one = spawnSync(process.execPath, [fixture, "20", "0.2", "1"], { encoding: "utf8" });
  assert.match(one.stdout, /^status-redraw start rate=20 rows=1\n\n\x1b\[1A\r\x1b\[2K/);
  assert.equal(spawnSync(process.execPath, [fixture, "0", "1", "1"], { encoding: "utf8" }).status, 1, "a rate of 0 was accepted");
  assert.equal(spawnSync(process.execPath, [fixture, "20", "1", "0"], { encoding: "utf8" }).status, 1, "0 rows were accepted");
});

test("the B3 output of the redraw takes its conditions from b3-out with the performance switch of the trace state", () => {
  const policy = { lifecycle: "error", input: "error", call: "debug", io: "error", frame: "debug" };
  const status = redrawWindow({ scale: 2, refreshRate: 120 });
  const conditions = redrawConditions({ status, window: "w2", trace: 1, policy });
  assert.deepEqual(conditions, { refreshRate: 120, refreshRates: { w2: 120 }, backingScale: 2, traceState: true, logPolicy: policy, window: { width: 760, height: 614 }, occluded: false, active: true });
  assert.equal(redrawConditions({ status, window: "w2", trace: 0, policy }).traceState, false);
  // A window on no screen records the refresh rate null, and the judge fails each period bound that it cannot judge.
  const offScreen = redrawConditions({ status: redrawWindow({ scale: 2, refreshRate: null }), window: "w2", trace: 0, policy });
  assert.deepEqual([offScreen.refreshRate, offScreen.refreshRates], [null, { w2: null }]);
  const rows = [{ role: "host", pid: 10, cpuSeconds: 0.9 }];
  const totals = { application: { cpuSeconds: 0.9 }, sidecars: { cpuSeconds: 0 }, total: { cpuSeconds: 0.9 } };
  const output = { measurements: redrawMeasurements(frameCost({ rows, totals, presented: 300, seconds: 10 })), conditions };
  const folder = mkdtempSync(join(tmpdir(), "b3-redraw-"));
  try {
    writeB3Out(join(folder, "S2.json"), output);
    assert.deepEqual(readB3Out(join(folder, "S2.json")), output);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the conditions of the redraw read the window again after the interval, so a window that was covered or lost its activation is recorded", { timeout: 30000 }, async (t) => {
  const { s, server } = await play(t, "measure-redraw-conditions");
  s.window = "w2";
  const policy = { lifecycle: "error", input: "error", call: "debug", io: "error", frame: "debug" };
  const status = redrawWindow({ scale: 2, refreshRate: 120 });
  const read = () => readRedrawConditions({ s, status, trace: 0, policy });
  const { occluded, active } = await read();
  assert.deepEqual({ occluded, active }, { occluded: false, active: true });
  assert.equal((await read()).occluded, true);
  assert.equal((await read()).active, false);
  await server.played;
});

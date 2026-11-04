import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readB3Out, writeB3Out } from "../b3-out.mjs";

import { B3_MEASUREMENTS, frameCost, redrawConditions, measureRegion, parseOptions, prepareRedraw, presentedFramesOf, redrawMeasurements, requireRows, screenText } from "../measure-terminal-redraw.mjs";

test("the text of a screen joins the characters of each row and counts an empty cell as spaces of its width", () => {
  assert.equal(screenText([[{ ch: "a", width: 1 }, { width: 1 }, { ch: "b", width: 1 }], [{ ch: "한", width: 2 }, { width: 0 }]]), "a b\n한");
  assert.throws(() => screenText(null), /terminal screen is not a list of rows/);
});

test("the options require the application, the plugin, the rows and the trace state, a rate from 1 to 120 and no surface", () => {
  const base = ["--sok", "/bin/sok", "--config-dir", "/tmp/c", "--plugin", "probe", "--rows", "20", "--trace", "0"];
  assert.deepEqual(parseOptions(base),
    { sok: "/bin/sok", configDir: "/tmp/c", plugin: "probe", rows: 20, rate: 20, interval: 10, trace: 0, b3Out: null, json: false });
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

/** A session of a window check (get, run, request, until, on) whose answers come from answer(kind, window, name, params, surface). */
function fakeSession(answer, window = "w1", calls = []) {
  const entry = async (kind, name, params, surface) => {
    calls.push(surface === undefined ? [kind, window, name, params] : [kind, window, name, params, surface]);
    return answer(kind, window, name, params, surface);
  };
  return {
    window,
    calls,
    on: (other) => fakeSession(answer, other, calls),
    get: (name, surface) => entry("get", name, undefined, surface),
    run: (name, params = {}, surface) => entry("run", name, params, surface),
    request: (method, params = {}) => entry("request", method, params),
    until: async (name, predicate, message, { surface } = {}) => {
      const value = await entry("until", name, undefined, surface);
      if (!predicate(value)) throw new Error(`until ${name} of ${window}: ${message}; value ${JSON.stringify(value)}`);
      return value;
    },
  };
}

test("the measurement opens one tab of the plugin in a new project window of 760 by 614 points", async () => {
  const windows = [{ window: "w1", ready: true }];
  const answer = (kind, window, name) => {
    if (name === "core.window.new") {
      windows.push({ window: "w2", ready: true });
      return null;
    }
    if (name === "host.windows") return windows.map((entry) => ({ ...entry }));
    if (name === "core.project.open") return { id: "p2" };
    if (name === "host.window") return redrawWindow();
    if (name === "core.grid") return { cards: [{ id: "c1", fixed: false, tabs: [{ id: "t-old", plugin: "other" }] }] };
    if (name === "core.card.add-tab") return { tab: "tab-1" };
    if (name === "core.tab.close") return { closed: true };
    if (name === "core.surfaces") {
      return [{ kind: "tab", surface: "tab-1", plugin: "probe", exposes: ["command probe.input", "status probe.screen"], status: { phase: "ready", error: null } }];
    }
    return null;
  };
  const calls = [];
  const s = fakeSession(answer, "w1", calls);
  const prepared = await prepareRedraw(s, "probe", "/var/tester/redraw-project");
  assert.deepEqual(calls.filter(([kind]) => kind !== "get"), [
    ["run", "w1", "core.window.new", {}],
    ["until", "w1", "host.windows", undefined],
    ["run", "w2", "core.project.open", { root: "/var/tester/redraw-project" }],
    ["run", "w2", "host.window.resize", { width: 760, height: 614 }],
    ["until", "w2", "host.window", undefined],
    ["run", "w2", "core.card.add-tab", { card: "c1", plugin: "probe" }],
    ["run", "w2", "core.tab.close", { tab: "t-old" }],
    ["until", "w2", "core.surfaces", undefined],
    ["until", "w2", "core.surfaces", undefined],
  ]);
  assert.equal(prepared.s.window, "w2");
  assert.deepEqual([prepared.tab, prepared.project], ["tab-1", "p2"]);
});

test("the region measurement reads presentedFrames right around the cpu interval and fails while the window is occluded", async () => {
  let presented = 120;
  const s = fakeSession((kind, window, name) => (name === "host.window" ? redrawWindow({ regions: [{ surface: "tab-1", name: "screen", presentedFrames: presented }] }) : null), "w2");
  const measure = async (marks) => {
    const before = await marks.before();
    presented += 300;
    const after = await marks.after();
    return { seconds: 10, marks: { before, after }, apps: [{ rows: [{ role: "host", pid: 10, cpuSeconds: 1.5 }], totals: { application: { cpuSeconds: 1.5 }, sidecars: { cpuSeconds: 0 }, total: { cpuSeconds: 1.5 } } }], errors: [] };
  };
  const result = await measureRegion({ s, tab: "tab-1", interval: 10, measure, covered: async () => null });
  assert.equal(result.cost.presented, 300);
  assert.equal(result.cost.totals.total, 5);
  assert.deepEqual(result.status.content, { x: 0, y: 28, width: 760, height: 614 });
  await assert.rejects(measureRegion({ s, tab: "tab-1", interval: 10, measure, covered: async () => redrawWindow({ occluded: true }) }),
    /window w2 reported occluded true during the interval/);
  const covered = fakeSession((kind, window, name) => (name === "host.window" ? redrawWindow({ occluded: true }) : null), "w2");
  await assert.rejects(measureRegion({ s: covered, tab: "tab-1", interval: 10, measure, covered: async () => null }),
    /window w2 reports occluded true; the measurement requires occluded false/);
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
  assert.deepEqual(conditions, { refreshRate: 120, backingScale: 2, traceState: true, logPolicy: policy, window: { width: 760, height: 614 } });
  assert.equal(redrawConditions({ status, window: "w2", trace: 0, policy }).traceState, false);
  assert.throws(() => redrawConditions({ status: redrawWindow({ scale: 2, refreshRate: null }), window: "w2", trace: 0, policy }),
    /window w2 reports the refresh rate null, so it is on no screen/);
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

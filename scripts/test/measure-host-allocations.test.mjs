import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { B3_MEASUREMENTS, b3Output, heapTotals, measure, parseOptions, prepare, windowFrames } from "../measure-host-allocations.mjs";
import { SETTLE_RULE } from "../footprints.mjs";

test("the totals are the nodes and bytes of the line of all zones, and output without it is an error", () => {
  assert.deepEqual(heapTotals("Process 7: 9 zones\nAll zones: 77466 nodes malloced - Sizes: 32[1]\nAll zones: 77466 nodes (18570120 bytes)\n"),
    { nodes: 77466, bytes: 18570120 });
  assert.throws(() => heapTotals("heap: no such process"), /heap printed no line "All zones: N nodes \(B bytes\)": heap: no such process/);
});

test("the measurement records the totals and the footprint at start and each minute, then the footprint after it settles by the rule of G3", async () => {
  const entries = [];
  const waits = [];
  let clock = 0;
  let calls = 0;
  const footprints = [100, 200, 300, 900 * 1024, 900 * 1024 + 1000];
  const frames = [[40], [41], [41], [41], [41], [41]];
  const settledBytes = await measure({
    pid: 7, minutes: 2,
    totals: () => ({ nodes: ++calls, bytes: calls * 10 }),
    footprint: async (pid) => {
      assert.equal(pid, 7);
      return footprints.shift();
    },
    readWindows: async () => [{ window: "w1", occluded: false }],
    readFrames: async () => frames.shift(),
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    log: (entry) => entries.push(entry),
    now: () => clock,
  });
  assert.equal(settledBytes, 900 * 1024 + 1000, "the settled footprint is the second of the two readings that are closer than 1,024 KB after the last frame");
  assert.deepEqual(entries, [
    { phase: "start", elapsedMs: 0, pid: 7, nodes: 1, bytes: 10, footprint: 100 },
    { phase: "minute 1", elapsedMs: 60000, pid: 7, nodes: 2, bytes: 20, footprint: 200 },
    { phase: "minute 2", elapsedMs: 120000, pid: 7, nodes: 3, bytes: 30, footprint: 300 },
    { phase: "settled", elapsedMs: 120000 + 2 * SETTLE_RULE.intervalMs - (SETTLE_RULE.intervalMs - SETTLE_RULE.quietMs), pid: 7, footprint: 900 * 1024 + 1000 },
  ]);
  assert.deepEqual(waits, [60000, 60000, SETTLE_RULE.quietMs, SETTLE_RULE.intervalMs - SETTLE_RULE.quietMs, SETTLE_RULE.quietMs]);
});

test("the frames of the windows are counts or null, and another value is an error that names the window", () => {
  assert.deepEqual(windowFrames([{ window: "w1", frames: 41 }, { window: "w2", frames: null }]), [41, null]);
  assert.throws(() => windowFrames([{ window: "w1", frames: 41 }, { window: "w2", frames: -1 }]), /window w2 reports frames -1, not a count or null/);
  assert.throws(() => windowFrames([{ window: "w1" }]), /window w1 reports frames undefined, not a count or null/);
  assert.throws(() => windowFrames([{ window: "w1", frames: 1.5 }]), /window w1 reports frames 1.5, not a count or null/);
});

test("B3_MEASUREMENTS declares hostFootprintKb, the settled footprint in KB that b3Output gives with the conditions of the windows", () => {
  assert.deepEqual(B3_MEASUREMENTS, ["hostFootprintKb"]);
  assert.ok(Object.isFrozen(B3_MEASUREMENTS));
  const policy = { lifecycle: "error", input: "error", call: "error", io: "error", frame: "error" };
  const windows = [
    { window: "w1", refreshRate: 120, scale: 2, content: { width: 1200, height: 760 }, frames: 41, occluded: false, active: true },
    { window: "w2", refreshRate: 120, scale: 2, content: { width: 600, height: 400 }, frames: null },
  ];
  const output = b3Output({ settledBytes: 81 * 1024 * 1024 + 512, windows, trace: 0, policy });
  assert.deepEqual(output, {
    measurements: { hostFootprintKb: 81 * 1024 + 0.5 },
    conditions: { refreshRate: 120, refreshRates: { w1: 120, w2: 120 }, backingScale: 2, traceState: false, logPolicy: policy, window: { width: 1200, height: 760 }, occluded: false, active: true },
  });
  assert.deepEqual(Object.keys(output.measurements), B3_MEASUREMENTS);
  assert.equal(b3Output({ settledBytes: 1024, windows, trace: 1, policy }).conditions.traceState, true);
});

test("a covered window fails the measurement at the reading that finds it: at the start, at a minute and after the settle", async () => {
  for (const [readings, phases] of [[[true], []], [[false, true], ["start"]], [[false, false, true], ["start", "minute 1"]]]) {
    const entries = [];
    await assert.rejects(measure({
      pid: 7, minutes: 1,
      totals: () => ({ nodes: 1, bytes: 1 }),
      footprint: async () => 1,
      readFrames: async () => [1],
      readWindows: async () => [{ window: "w1", occluded: readings.shift() }],
      wait: async () => {},
      log: (entry) => entries.push(entry),
    }), /window w1 reports occluded true; the measurement requires occluded false/);
    assert.deepEqual(entries.map(({ phase }) => phase), phases);
  }
});

test("the options name the application by its configuration folder and sok, and take the trace state", () => {
  assert.deepEqual(parseOptions(["--sok", "/s", "--config-dir", "/c", "--trace", "1"]), { sok: "/s", configDir: "/c", trace: 1, minutes: 10, b3Out: null });
  assert.equal(parseOptions(["--sok", "/s", "--config-dir", "/c", "--trace", "0", "--minutes", "60", "--b3-out", "/o/s4.json"]).b3Out, "/o/s4.json");
  assert.throws(() => parseOptions(["--sok", "/s", "--config-dir", "/c", "--trace", "0", "--minutes", "60", "--b3-out", ""]), /--b3-out must name a file/);
  assert.throws(() => parseOptions(["--sok", "/s", "--config-dir", "/c", "--trace", "0", "--b3-out", "/o/s4.json"]),
    /--b3-out needs at least 60 minutes, the minutes of S4, not 10/);
  assert.equal(parseOptions(["--sok", "/s", "--config-dir", "/c", "--trace", "0", "--minutes", "3"]).minutes, 3);
  assert.throws(() => parseOptions(["--sok", "/s", "--config-dir", "/c"]), /TRACE must be 0 or 1, not set/);
  assert.throws(() => parseOptions(["--sok", "/s", "--config-dir", "/c", "--trace", "2"]), /TRACE must be 0 or 1, not "2"/);
  assert.throws(() => parseOptions(["--config-dir", "/c", "--trace", "0"]), /required options: --sok PATH --config-dir DIR/);
  assert.throws(() => parseOptions(["--sok", "/s", "--config-dir", "/c", "--trace", "0", "--minutes", "0"]), /--minutes must be a positive integer/);
  assert.throws(() => parseOptions(["--pid", "7", "--trace", "0"]), /Unknown option '--pid'/);
});

test("the host is the process of the release bundle of the mygo host that has the --config-dir of the application, and the trace state is set", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "host-allocations-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const processes = [
    { pid: 10, command: `node scripts/measure-host-allocations.mjs --sok /s --config-dir ${configDir} --trace 1` },
    { pid: 11, command: `/app/target/release/mygo/soksak.app/Contents/MacOS/sok-mygo --config-dir ${configDir}` },
    { pid: 12, command: `${configDir}/sidecars/pty/0.0.1/pty --config-dir ${configDir}` },
    { pid: 13, command: "/app/target/release/wailsv3/soksak.app/Contents/MacOS/sok-wailsv3 --config-dir /other" },
  ];
  const calls = [];
  const run = async (command, params) => {
    calls.push([command, params.key]);
    if (params.key === "diagnostics.log") {
      const classes = { lifecycle: "error", input: "error", call: "error", io: "error", frame: "error", ...params.value };
      setTimeout(() => writeFileSync(join(configDir, "log-policy.json"), JSON.stringify({ schema: 1, classes })), 20);
    }
    return null;
  };
  assert.equal(await prepare({ processes, configDir, realPath: configDir, run, trace: 1 }), 11);
  assert.deepEqual(calls, [["core.settings.change", "diagnostics.log"], ["core.settings.change", "diagnostics.performance"]]);
  await assert.rejects(prepare({ processes: processes.filter(({ pid }) => pid !== 11), configDir, realPath: configDir, run, trace: 1 }),
    new RegExp(`no host process has --config-dir ${configDir}`));
  assert.equal(calls.length, 2, "the trace state was set for an application without a host process");
});

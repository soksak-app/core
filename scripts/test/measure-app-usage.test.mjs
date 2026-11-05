import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";

import { readB3Out, writeB3Out } from "../b3-out.mjs";

import {
  applicationRows,
  attributeWebKit,
  B3_MEASUREMENTS,
  cpuPercent,
  execute,
  faultErrorCount,
  gestureFigures,
  hostProcess,
  measureApps,
  measurePointer,
  parseCpuSamples,
  parseCpuTime,
  parseOptions,
  parseProcessTable,
  pointerPath,
  prepareState,
  readCpuSeconds,
  requireOcclusion,
  sidecarProcesses,
  STATES,
  totalsOf,
  usageOutput,
  untilFramesQuiet,
  usageMeasurements,
  waitIdle,
  notMeasuredLines,
  windowApplicationRows,
  windowRows,
} from "../measure-app-usage.mjs";

const DIR = "/Users/tester/Library/Application Support/soksak-check";

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
    `  10 /Applications/soksak-check.app/Contents/MacOS/soksak --config-dir ${DIR}`,
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
    `  10 /Applications/soksak-check.app/Contents/MacOS/soksak --config-dir ${launched} --registry-ca ${launched}/ca.pem`,
    `  11 ${launched}/sidecars/probe/bin/probe --config-dir ${launched}`,
  ].join("\n"));
  assert.deepEqual(hostProcess(table, DIR), { pid: 10 });
  assert.deepEqual(sidecarProcesses(table, DIR), [{ role: "sidecar probe", pid: 11, attribution: "executable path" }]);
});

test("finds the host and the sidecars of a data folder that the processes launch by its real path", () => {
  const given = "/var/tester/soksak-check";
  const real = "/private/var/tester/soksak-check";
  const table = parseProcessTable([
    `  10 /Applications/soksak-check.app/Contents/MacOS/soksak --config-dir ${real}`,
    `  11 ${real}/sidecars/probe/bin/probe --x`,
  ].join("\n"));
  assert.deepEqual(hostProcess(table, given, real), { pid: 10 });
  assert.deepEqual(sidecarProcesses(table, given, real), [{ role: "sidecar probe", pid: 11, attribution: "executable path" }]);
});

test("reports a missing or duplicate host", () => {
  const none = parseProcessTable("  15 /usr/bin/other --config-dir /elsewhere\n");
  assert.throws(() => hostProcess(none, DIR), /no host process has --config-dir .*soksak-check/);
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

/** The `launchctl print pid/<host>` output of a host whose WebKit services run as gpu, networking and webContent. */
function launchdDomain({ gpu, networking, webContent }) {
  return [
    "pid/0 = {",
    "\tservices = {",
    "\t\t       0      - \tcom.apple.WebKit.GPU",
    `\t\t   ${gpu}      - \tcom.apple.WebKit.GPU.79E5AEE6-A76D-4B8E-9BE4-197F4E2ACD4D`,
    `\t\t   ${networking}      - \tcom.apple.WebKit.Networking.D60DD8E6-6C1D-45D1-AAA5-B4D63E6E2417`,
    "\t\t       0      - \tcom.apple.WebKit.Networking",
    `\t\t   ${webContent}      - \tcom.apple.WebKit.WebContent.042944D2-1A7A-492A-819D-BBAEEE5A28D3`,
    "\t}",
    "}",
  ].join("\n");
}

test("attributes the WebKit services of two hosts that started in the same second by the launchd domain of each host", async () => {
  const second = new Date(2026, 9, 18, 6, 52, 13).getTime();
  const domains = new Map([
    [100, launchdDomain({ gpu: 301, networking: 300, webContent: 302 })],
    [200, launchdDomain({ gpu: 401, networking: 400, webContent: 402 })],
  ]);
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    const host = Number(args[1].slice("pid/".length));
    return { status: 0, stdout: domains.get(host), stderr: "" };
  };
  const result = await attributeWebKit(
    [
      { configDir: DIR, pid: 100, startedAt: second + 100 },
      { configDir: "/Users/tester/other", pid: 200, startedAt: second + 400 },
    ],
    run,
  );
  assert.deepEqual(result.attributed, [
    { configDir: DIR, role: "webkit gpu", pid: 301, attribution: "launchd domain" },
    { configDir: DIR, role: "webkit networking", pid: 300, attribution: "launchd domain" },
    { configDir: DIR, role: "webkit webcontent", pid: 302, attribution: "launchd domain" },
    { configDir: "/Users/tester/other", role: "webkit gpu", pid: 401, attribution: "launchd domain" },
    { configDir: "/Users/tester/other", role: "webkit networking", pid: 400, attribution: "launchd domain" },
    { configDir: "/Users/tester/other", role: "webkit webcontent", pid: 402, attribution: "launchd domain" },
  ]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(calls, [
    ["/bin/launchctl", "print", "pid/100"],
    ["/bin/launchctl", "print", "pid/200"],
  ]);
});

test("a host whose launchd domain cannot be read is an error that names the data folder", async () => {
  const run = () => ({ status: 113, stdout: "", stderr: "Could not find domain for pid: 100" });
  const result = await attributeWebKit([{ configDir: DIR, pid: 100 }], run);
  assert.deepEqual(result.attributed, []);
  assert.deepEqual(result.errors, [`webkit services of ${DIR}: launchctl print pid/100 exited with 113: Could not find domain for pid: 100`]);
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

/** The host.window of a window of the mygo host: no main page, the frame counters of U7 and one image region of a term surface. */
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

test("the options take a state, the idle wait, the pointer step and the trace state", () => {
  assert.deepEqual(parseOptions(["--sok", "/b/sok", "--config-dir", MYGO, "--trace", "0"]),
    { sok: "/b/sok", configDirs: [MYGO], interval: 10, state: null, idle: false, step: null, trace: 0, b3Out: null, json: false });
  assert.deepEqual(
    parseOptions(["--sok", "/b/sok", "--config-dir", MYGO, "--state", "S9", "--idle", "--step", "pointer", "--trace", "1", "--interval", "240",
      "--b3-out", "/var/tester/b3/S9.json"]),
    { sok: "/b/sok", configDirs: [MYGO], interval: 240, state: "S9", idle: true, step: "pointer", trace: 1, b3Out: "/var/tester/b3/S9.json", json: false });
  assert.deepEqual(STATES, ["S0", "S0b", "S1", "S9", "S11", "S12", "S14", "S15"]);
  const base = ["--sok", "/b/sok", "--config-dir", MYGO, "--trace", "0"];
  assert.throws(() => parseOptions([...base, "--state", "S2"]), /--state must be one of S0, S0b, S1, S9, S11, S12, S14, S15 \(S2\)/);
  assert.throws(() => parseOptions([...base, "--step", "key"]), /--step must be pointer \(key\)/);
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

test("an idle wait over a window whose frames is null reports that no frame was read, and frames that hold still report quiet", async () => {
  const s = fakeSession((kind, window, name) => (name === "core.surfaces" ? [] : {}));
  const sleep = async () => {};
  assert.equal(await waitIdle({ sessions: [s], frames: async () => [null], sleep }), "not measured");
  assert.equal(await waitIdle({ sessions: [s], frames: async () => [12, null], sleep }), "not measured");
  assert.equal(await waitIdle({ sessions: [s], frames: async () => [12, 40], sleep }), "quiet");
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

test("a window whose frames is null waits 3 seconds once", async () => {
  const waits = [];
  await untilFramesQuiet({ frames: async () => [null], sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [3000]);
});

test("without sleep the quiet wait waits the 3 seconds of G2 on the timer of the module", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let settled = false;
    const quiet = untilFramesQuiet({ frames: async () => [340] }).then((frames) => { settled = true; return frames; });
    const turns = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); };
    await turns();
    mock.timers.tick(2999);
    await turns();
    assert.equal(settled, false);
    mock.timers.tick(1);
    assert.deepEqual(await quiet, [340]);
  } finally {
    mock.timers.reset();
  }
});

test("the frames of every window must not change for 3 seconds", async () => {
  const values = [[10, null], [12, null], [12, null]];
  const waits = [];
  await untilFramesQuiet({ frames: async () => values.shift(), sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [3000, 3000]);
  let frame = 0;
  await assert.rejects(untilFramesQuiet({ frames: async () => [frame++], sleep: async () => {}, intervals: 2 }),
    /the frames of the windows changed in each of 2 intervals of 3 s; frames 1 then 2/);
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

test("the idle wait waits for the cursor idle timeout of every term tab and then for 3 seconds without a frame", async () => {
  const surfaces = [
    { kind: "tab", surface: "tab-1", plugin: "term", exposes: ["status term.screen", "status term.cursor"] },
    { kind: "tab", surface: "tab-3", plugin: "term", exposes: ["status term.cursor"] },
    { kind: "tab", surface: "tab-2", plugin: "browser", exposes: ["status browser.location"] },
    { kind: "section", surface: "sec-1", plugin: "probe", exposes: ["status probe.cursor"] },
  ];
  const idle = { "tab-1": 5000, "tab-3": 7000 };
  const s = fakeSession((kind, window, name, params, surface) => (name === "core.surfaces" ? surfaces : { idleTimeout: idle[surface] }));
  const waits = [];
  await waitIdle({ sessions: [s], frames: async () => [null], sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [7000, 3000]);
  assert.deepEqual(s.calls.filter(([kind]) => kind === "get").map((call) => call.slice(2)),
    [["core.surfaces", undefined], ["term.cursor", undefined, "tab-1"], ["term.cursor", undefined, "tab-3"]]);
  const broken = fakeSession((kind, window, name) => (name === "core.surfaces" ? surfaces.slice(0, 1) : { idleTimeout: "5s" }));
  await assert.rejects(waitIdle({ sessions: [broken], frames: async () => [null], sleep: async () => {} }),
    /surface tab-1 of window w1 reports term.cursor idleTimeout "5s", not a number of milliseconds/);
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

test("the pointer step sends input.pointer moves without activating the window, and repeats them in the trace state of the frame records to read the U7 records", async () => {
  const calls = [];
  let frames = 340;
  const moves = [];
  const s = fakeSession((kind, window, name, params) => {
    if (name === "input.pointer") {
      moves.push(params);
      if (moves.length % 61 === 0) frames += 4;
      if (moves.length % 61 === 1) calls.push("moving");
      return null;
    }
    calls.push(`${kind} ${name}`);
    return name === "host.window" ? mygoWindow({ frames }) : null;
  });
  const result = await measurePointer({
    s,
    measure: async ({ span }) => { calls.push("measure"); await span(); calls.push("measured"); return { apps: [] }; },
    frameRecords: async () => { calls.push("frameRecords"); },
    restore: async () => { calls.push("restore"); },
    tail: async () => { calls.push("tail"); return { "host-1-10": 100 }; },
    records: async (since) => { calls.push(`records ${JSON.stringify(since)}`); return { records: u7Move(MOVES), dropped: [], fromSeq: 100, toSeq: 112 }; },
  });
  assert.deepEqual(calls, [
    "get host.window",
    "measure", "moving", "measured",
    "frameRecords",
    "get host.window", "tail", "moving", "get host.window", "request diagnostics.log.flush",
    'records {"host-1-10":100}',
    "restore",
  ]);
  assert.equal(moves.length, 122);
  assert.deepEqual(moves[0], { x: 1, y: 380, phase: "move" });
  assert.deepEqual(result.gesture, { window: "w1", frameRecords: 4, moves: 4, p90Ms: 6, framesChange: 4 });
});

test("the pointer step reads the frames of the gesture before the flush, so a frame presented after the flush is in neither", async () => {
  // The host writes the U7 record of a presented frame to the files at the flush; a frame presents right after the flush.
  let frames = 340;
  let flushedFrames = 340;
  let moved = 0;
  const s = fakeSession((kind, window, name) => {
    if (name === "input.pointer" && ++moved % 61 === 0) frames += 4;
    if (name === "host.window") return mygoWindow({ frames });
    if (name === "diagnostics.log.flush") {
      flushedFrames = frames;
      frames += 1;
    }
    return null;
  });
  const result = await measurePointer({
    s,
    measure: async ({ span }) => { await span(); return { apps: [] }; },
    frameRecords: async () => {},
    restore: async () => {},
    tail: async () => ({ "host-1-10": 100 }),
    records: async () => {
      const moves = MOVES.slice(0, flushedFrames - 344);
      return { records: u7Move(moves), dropped: [], fromSeq: 100, toSeq: 100 + moves.length * 3 };
    },
  });
  assert.deepEqual(result.gesture, { window: "w1", frameRecords: 4, moves: 4, p90Ms: 6, framesChange: 4 });
});

test("the pointer step of a window with a main page repeats the move and reads no U7 records", async () => {
  const calls = [];
  let moved = 0;
  const s = fakeSession((kind, window, name) => {
    if (name === "input.pointer" && ++moved % 61 === 1) calls.push("moving");
    return name === "host.window" ? mygoWindow({ pageProcess: 501, frames: null }) : null;
  });
  const result = await measurePointer({
    s,
    measure: async ({ span }) => { await span(); return { apps: [] }; },
    frameRecords: async () => { calls.push("frameRecords"); },
    restore: async () => { calls.push("restore"); },
    tail: async () => { throw new Error("tail read"); },
    records: async () => { throw new Error("records read"); },
  });
  assert.deepEqual(calls, ["moving", "frameRecords", "moving", "restore"]);
  assert.equal(result.gesture, null);
});

const URL_BLANK = "http://127.0.0.1:4100/blank";

/**
 * The answers of a mygo application whose window w1 opens the fixture project with one terminal tab t-old in card c1; the
 * entries of `answers` replace an answer by `<kind> <window> <name>`.
 */
function appAnswers(answers = {}) {
  const windows = [{ window: "w1", ready: true }];
  return (kind, window, name, params, surface) => {
    const key = `${kind} ${window} ${name}`;
    if (key in answers) return typeof answers[key] === "function" ? answers[key](params, surface) : answers[key];
    if (name === "core.window.new") {
      windows.push({ window: "w2", ready: true });
      return null;
    }
    if (name === "host.windows") return windows.map((entry) => ({ ...entry }));
    if (name === "host.window") return mygoWindow(window === "w2" ? { frame: { x: 0, y: 0, width: 1320, height: 908 }, content: { x: 0, y: 28, width: params?.width ?? 1320, height: 880 } } : {});
    if (name === "core.grid") return { cards: [{ id: "left", fixed: true, tabs: [] }, { id: "c1", fixed: false, tabs: [{ id: "t-old", plugin: "terminal" }] }] };
    if (name === "core.card.add-tab") return { tab: "t-term" };
    if (name === "core.tab.close") return { closed: true };
    if (name === "core.card.split") return { card: "c2", tab: "t-web" };
    if (name === "core.surfaces") {
      return [
        { kind: "tab", surface: "t-term", plugin: "term", exposes: ["status term.cursor"], status: { phase: "ready", error: null } },
        { kind: "tab", surface: "t-web", plugin: "browser", exposes: ["status browser.location"], status: { phase: "ready", error: null } },
      ];
    }
    if (name === "browser.location") return { url: URL_BLANK, loading: false, error: null, title: "blank" };
    if (name === "core.settings-modal") return { open: true };
    if (name === "core.screen") return { screen: "library", modal: null };
    return null;
  };
}

/** The dependencies of prepareState that record their calls into calls. */
function prepareDeps(calls, overrides = {}) {
  return {
    applyTrace: async () => { calls.push("applyTrace"); },
    serve: async () => { calls.push("serve"); return URL_BLANK; },
    projectRoot: (name) => { calls.push(`projectRoot ${name}`); return `/var/tester/projects/${name}`; },
    logPosition: () => { calls.push("logPosition"); return { "host-1-10.jsonl": { offset: 400, inode: "7" } }; },
    untilFaultLine: async (position) => { calls.push(`untilFaultLine ${position["host-1-10.jsonl"].offset}`); },
    remainingWebKit: async () => { calls.push("remainingWebKit"); return [{ role: "webkit gpu", pid: 300, bytes: 30 * MB }]; },
    sleep: async (ms) => { calls.push(`sleep ${ms}`); },
    ...overrides,
  };
}

/** The calls of a prepared state without the reads of a status, which name what the preparation waits for. */
const actions = (calls) => calls.filter((call) => typeof call === "string" || call[0] === "run" || call[0] === "request" || call[0] === "until");

const S1_STEPS = [
  ["run", "w1", "host.window.resize", { width: 1200, height: 760 }],
  ["until", "w1", "host.window", undefined],
  ["request", "w1", "diagnostics.fixture", {}],
  "applyTrace",
  ["run", "w1", "core.card.add-tab", { card: "c1", plugin: "term" }],
  ["run", "w1", "core.tab.close", { tab: "t-old" }],
  ["until", "w1", "core.surfaces", undefined],
  "serve",
  ["run", "w1", "core.card.split", { card: "c1", side: "right", plugin: "browser" }],
  ["until", "w1", "core.surfaces", undefined],
  ["run", "w1", "browser.navigate", { url: URL_BLANK }, "t-web"],
  ["until", "w1", "browser.location", undefined, "t-web"],
];

test("S1 opens one term tab and one browser tab on the blank loopback page in a window of 1200 by 760 points", async () => {
  const calls = [];
  const s = fakeSession(appAnswers(), "w1", calls);
  const context = await prepareState(s, "S1", prepareDeps(calls));
  assert.deepEqual(actions(calls), S1_STEPS);
  assert.deepEqual(context, { state: "S1", windows: ["w1"], url: URL_BLANK, footprints: "settled" });
});

test("S0 and S14 keep the library screen, and S14 types one character into the library search 10 seconds before the reading", async () => {
  const calls = [];
  const s = fakeSession(appAnswers({ "get w1 core.surfaces": [] }), "w1", calls);
  assert.deepEqual(await prepareState(s, "S0", prepareDeps(calls)), { state: "S0", windows: ["w1"], footprints: "settled" });
  assert.deepEqual(actions(calls), S1_STEPS.slice(0, 2).concat(["applyTrace"]));
  calls.length = 0;
  assert.deepEqual(await prepareState(s, "S14", prepareDeps(calls)), { state: "S14", windows: ["w1"], footprints: "at-once" });
  assert.deepEqual(actions(calls), S1_STEPS.slice(0, 2).concat([
    "applyTrace",
    ["run", "w1", "core.library.search.focus", {}],
    ["request", "w1", "input.key", { key: "a", phase: "down" }],
    ["request", "w1", "input.key", { key: "a", phase: "up" }],
    "sleep 10000",
  ]));
  const shown = fakeSession(appAnswers(), "w1", []);
  await assert.rejects(prepareState(shown, "S0", prepareDeps([])), /S0 requires a window without plugin views; window w1 shows t-term, t-web/);
  const project = fakeSession(appAnswers({ "get w1 core.surfaces": [], "get w1 core.screen": { screen: "workspace", modal: null } }), "w1", []);
  await assert.rejects(prepareState(project, "S0", prepareDeps([])), /S0 requires the library screen; window w1 shows workspace/);
});

test("S0b closes the project and waits for the exit of each WebContent process of a view page or a document region", async () => {
  const calls = [];
  const answers = appAnswers({
    "get w1 core.project": { id: "p1" },
    "get w1 host.window": mygoWindow({ documents: [{ surface: "tab-2", document: "doc-1", process: 902 }, { surface: "tab-5", document: "", process: 903 }] }),
    "run w1 core.project.close": { closed: true },
  });
  const s = fakeSession(answers, "w1", calls);
  const context = await prepareState(s, "S0b", prepareDeps(calls));
  assert.deepEqual(actions(calls), S1_STEPS.slice(0, 2).concat([
    "applyTrace",
    ["run", "w1", "core.project.close", { id: "p1" }],
    ["request", "w1", "diagnostics.process.exit", { pid: 902 }],
    ["request", "w1", "diagnostics.process.exit", { pid: 903 }],
    "remainingWebKit",
  ]));
  assert.deepEqual(context, { state: "S0b", windows: ["w1"], footprints: "settled", exited: [902, 903], remaining: [{ role: "webkit gpu", pid: 300, bytes: 30 * MB }] });
  const kept = fakeSession(appAnswers({ "get w1 core.project": { id: "p1" }, "run w1 core.project.close": { closed: false } }), "w1", []);
  await assert.rejects(prepareState(kept, "S0b", prepareDeps([])), /core.project.close kept the project p1 \(closed false\)/);
});

test("S9 places a second library window over the window of S1 and requires occluded true", async () => {
  const calls = [];
  let covered = false;
  const answers = appAnswers({
    "run w2 host.window.move": () => { covered = true; return null; },
    "until w1 host.window": () => mygoWindow({ occluded: covered }),
    "get w1 host.window": () => mygoWindow({ occluded: covered }),
  });
  const s = fakeSession(answers, "w1", calls);
  const context = await prepareState(s, "S9", prepareDeps(calls));
  assert.deepEqual(actions(calls).slice(S1_STEPS.length), [
    ["run", "w1", "core.window.new", {}],
    ["until", "w1", "host.windows", undefined],
    ["run", "w2", "host.window.resize", { width: 1320, height: 880 }],
    ["until", "w2", "host.window", undefined],
    ["run", "w2", "host.window.move", { x: 40, y: -10 }],
    ["until", "w1", "host.window", undefined],
  ]);
  assert.deepEqual(context.windows, ["w1", "w2"]);
  const open = fakeSession(appAnswers(), "w1", []);
  await assert.rejects(prepareState(open, "S9", prepareDeps([])), /until host.window of w1: the second window did not cover window w1/);
});

test("S11 opens a second project window beside the window of S1", async () => {
  const calls = [];
  const s = fakeSession(appAnswers({ "until w2 host.window": () => mygoWindow({ frame: { x: 0, y: 0, width: 1200, height: 788 } }) }), "w1", calls);
  const context = await prepareState(s, "S11", prepareDeps(calls));
  assert.deepEqual(actions(calls).slice(S1_STEPS.length), [
    ["run", "w1", "core.window.new", {}],
    ["until", "w1", "host.windows", undefined],
    "projectRoot S11",
    ["run", "w2", "core.project.open", { root: "/var/tester/projects/S11" }],
    ["run", "w2", "host.window.resize", { width: 1200, height: 760 }],
    ["until", "w2", "host.window", undefined],
    ["run", "w2", "host.window.move", { x: 1300, y: 50 }],
  ]);
  assert.deepEqual(context.windows, ["w1", "w2"]);
});

test("S12 makes one layout draw fail and waits for its error line, and S15 opens the settings window", async () => {
  const calls = [];
  const s = fakeSession(appAnswers(), "w1", calls);
  const context = await prepareState(s, "S12", prepareDeps(calls));
  assert.deepEqual(actions(calls).slice(S1_STEPS.length), [
    "logPosition",
    ["request", "w1", "diagnostics.layout.fail", {}],
    ["run", "w1", "host.window.resize", { width: 1160, height: 760 }],
    "untilFaultLine 400",
    ["run", "w1", "host.window.resize", { width: 1200, height: 760 }],
    ["until", "w1", "host.window", undefined],
  ]);
  assert.deepEqual(context.faultLog, { "host-1-10.jsonl": { offset: 400, inode: "7" } });
  calls.length = 0;
  await prepareState(s, "S15", prepareDeps(calls));
  assert.deepEqual(actions(calls).slice(S1_STEPS.length), [
    ["run", "w1", "core.settings.open", {}],
    ["until", "w1", "core.settings-modal", undefined],
  ]);
});

/** The process outputs of a mygo application of MYGO with host 10, a sidecar 11, one document 902 and the WebKit GPU 300. */
function mygoProcesses({ footprints, cpu }) {
  return async (command, args) => {
    const line = [command, ...args].join(" ");
    const ok = (stdout) => ({ status: 0, stdout, stderr: "" });
    if (line === "ps -axww -o pid=,command=") return ok(`   10 /Applications/soksak-mygo.app/Contents/MacOS/soksak --config-dir ${MYGO}\n   11 ${MYGO}/sidecars/probe/bin/probe\n`);
    if (line === `/b/sok windows --config-dir ${MYGO}`) return ok(JSON.stringify([{ window: "w1", ready: true }]));
    if (line === `/b/sok status host.window --window w1 --config-dir ${MYGO}`) return ok(JSON.stringify(mygoWindow()));
    if (line === "/bin/launchctl print pid/10") return ok(`\t\t   300      - \tcom.apple.WebKit.GPU.79E5AEE6-A76D-4B8E-9BE4-197F4E2ACD4D\n\t\t   902      - \tcom.apple.WebKit.WebContent.042944D2\n`);
    if (command === "pgrep") return { status: 1, stdout: "", stderr: "" };
    if (command === "footprint") {
      const pid = Number(args[1]);
      const [bytes, peak] = footprints(pid);
      return ok(`    phys_footprint: ${bytes} B\n    phys_footprint_peak: ${peak} B\n`);
    }
    if (line === "ps -axo pid=,time=") return ok(cpu().map(([pid, time]) => `${pid} ${time}`).join("\n"));
    throw new Error(`unexpected process ${line}`);
  };
}

test("measureApps reads a mygo application without a page row, settles its footprints and reads the marks around the cpu interval", async () => {
  const order = [];
  let reading = 0;
  let cpuReads = 0;
  const run = mygoProcesses({
    footprints: (pid) => [pid * MB + (reading < 4 ? reading * 2 * MB : 0), pid * MB * 2],
    cpu: () => (++cpuReads === 1 ? [[10, "0:01.00"], [11, "0:00.50"], [902, "0:02.00"], [300, "0:00.10"]] : [[10, "0:01.12"], [11, "0:00.50"], [902, "0:02.30"], [300, "0:00.20"]]),
  });
  const counted = async (command, args) => {
    if (command === "footprint" && args[1] === "10") reading += 1;
    return run(command, args);
  };
  const result = await measureApps({
    sok: "/b/sok", configDirs: [MYGO], interval: 240, footprints: "settled", run: counted, realpath: (path) => path,
    sleep: async (ms) => { order.push(`sleep ${ms}`); },
    marks: { before: async () => { order.push("before"); return "marks before"; }, after: async () => { order.push("after"); return "marks after"; } },
  });
  assert.deepEqual(result.errors, []);
  const rows = result.apps[0].rows.map(({ role, pid, bytes, peakBytes, cpuSeconds }) => ({ role, pid, bytes, peakBytes, cpuSeconds: Number(cpuSeconds.toFixed(2)) }));
  assert.deepEqual(rows, [
    { role: "host", pid: 10, bytes: 10 * MB, peakBytes: 20 * MB, cpuSeconds: 0.12 },
    { role: "sidecar probe", pid: 11, bytes: 11 * MB, peakBytes: 22 * MB, cpuSeconds: 0 },
    { role: "document tab-2/doc-1", pid: 902, bytes: 902 * MB, peakBytes: 1804 * MB, cpuSeconds: 0.3 },
    { role: "webkit gpu", pid: 300, bytes: 300 * MB, peakBytes: 600 * MB, cpuSeconds: 0.1 },
  ]);
  assert.ok(result.apps[0].rows.every((row) => !row.role.startsWith("page")), "a window without a main page has a page row");
  assert.equal(order.filter((entry) => entry === "sleep 3000").length, 5);
  assert.equal(order.filter((entry) => entry === "sleep 2000").length, 4);
  assert.deepEqual(order.slice(-3), ["before", "sleep 240000", "after"]);
  assert.deepEqual(result.marks, { before: "marks before", after: "marks after" });
  assert.equal(result.seconds, 240);
  assert.deepEqual(result.apps[0].totals.sidecars.bytes, 11 * MB);
  assert.deepEqual(result.apps[0].totals.application.bytes, (10 + 902 + 300) * MB);
});

/** The window marks of a measurement of two windows of the mygo host, before and after the cpu interval. */
function marksOfTwo({ frames = [[340, 340], [512, 513]], commandBuffers = [[338, 338], [500, 502]] } = {}) {
  const mark = (index) => [
    { window: "w1", occluded: false, frames: frames[0][index], commandBuffers: commandBuffers[0][index], scale: 2, refreshRate: 120, content: { width: 1200, height: 760 } },
    { window: "w2", occluded: false, frames: frames[1][index], commandBuffers: commandBuffers[1][index], scale: 2, refreshRate: 120, content: { width: 1200, height: 760 } },
  ];
  return { before: mark(0), after: mark(1) };
}

/** The process outputs of mygoProcesses with 700, a WebKit networking process of another application. */
function foreignProcesses({ footprintFails = () => false, foreignCpu, appCpu = () => [[10, "0:01.00"], [11, "0:00.50"], [902, "0:02.00"], [300, "0:00.10"]] }) {
  let cpuReads = 0;
  const run = mygoProcesses({
    footprints: (pid) => [pid * MB, pid * MB * 2],
    cpu: () => { cpuReads += 1; return [...appCpu(cpuReads), ...(foreignCpu(cpuReads) ? [[700, "0:00.10"]] : [])]; },
  });
  return async (command, args) => {
    if (command === "pgrep" && args[1] === "com.apple.WebKit.Networking") return { status: 0, stdout: "700\n", stderr: "" };
    if (command === "footprint" && args[1] === "700" && footprintFails()) return { status: 66, stdout: "", stderr: "footprint: Unable to find pid" };
    return run(command, args);
  };
}

const measureForeign = (run) => measureApps({
  sok: "/b/sok", configDirs: [MYGO], interval: 10, footprints: "at-once", run, realpath: (path) => path, sleep: async () => {},
});

test("measureApps leaves out a process of no application that ends between the cpu reads", async () => {
  let gone = false;
  const result = await measureForeign(foreignProcesses({
    footprintFails: () => gone,
    foreignCpu: (read) => { gone = read > 1; return !gone; },
  }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.unattributed.rows, []);
  assert.deepEqual(result.apps[0].rows.map(({ pid }) => pid), [10, 11, 902, 300]);
});

test("measureApps leaves out a process of no application that ended before its first footprint", async () => {
  const result = await measureForeign(foreignProcesses({ footprintFails: () => true, foreignCpu: () => false }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.unattributed.rows, []);
});

test("measureApps reports a process of no application that runs and has no footprint", async () => {
  const result = await measureForeign(foreignProcesses({ footprintFails: () => true, foreignCpu: () => true }));
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /unattributed webkit networking \(pid 700\): footprint -p 700 exited with 66/);
  assert.deepEqual(result.unattributed.rows.map(({ pid }) => pid), [700]);
});

test("measureApps reports a process of the application that ends between the cpu reads", async () => {
  const result = await measureForeign(foreignProcesses({
    foreignCpu: () => true,
    appCpu: (read) => [[10, "0:01.00"], ...(read === 1 ? [[11, "0:00.50"]] : []), [902, "0:02.00"], [300, "0:00.10"]],
  }));
  assert.deepEqual(result.errors, [`${MYGO} sidecar probe (pid 11): pid is not in the process table at both cpu reads`]);
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

test("the process listing of a configuration folder holds its host, its sidecars and the WebKit services of the domain of its host", async () => {
  const run = mygoProcesses({ footprints: () => [0, 0], cpu: () => [] });
  assert.deepEqual(await applicationRows({ configDir: MYGO, run, realpath: (path) => path }), [
    { role: "host", pid: 10, attribution: "config-dir argument" },
    { role: "sidecar probe", pid: 11, attribution: "executable path" },
    { role: "webkit gpu", pid: 300, attribution: "launchd domain" },
    { role: "webkit webcontent", pid: 902, attribution: "launchd domain" },
  ]);
  const noHost = async (command, args) => (command === "ps" ? { status: 0, stdout: `   11 ${MYGO}/sidecars/probe/bin/probe\n`, stderr: "" } : run(command, args));
  await assert.rejects(applicationRows({ configDir: MYGO, run: noHost, realpath: (path) => path }),
    new RegExp(`host of ${MYGO}: no host process has --config-dir ${MYGO}`));
});

test("the executor resolves to the status and the output of a command, and to the error of a command that does not start", async () => {
  const done = await execute(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"]);
  assert.deepEqual([done.status, done.stdout, done.stderr, done.error], [3, "out", "err", undefined]);
  const absent = await execute("/var/tester/no-such-command", []);
  assert.equal(absent.error.code, "ENOENT");
});

test("the cpu reading runs ps -axo pid=,time= and names the command of a failure", async () => {
  const run = mygoProcesses({ footprints: () => [0, 0], cpu: () => [[10, "0:01.25"], [902, "1:00.50"]] });
  assert.deepEqual(await readCpuSeconds(run), new Map([[10, 1.25], [902, 60.5]]));
  const failing = async () => ({ status: 1, stdout: "", stderr: "ps: no table" });
  await assert.rejects(readCpuSeconds(failing), /ps -axo pid=,time= exited with 1: ps: no table/);
});

test("the processes of the windows of an application are its listing with the page and document rows of each window, one row per pid", async () => {
  const run = mygoProcesses({ footprints: () => [0, 0], cpu: () => [] });
  const statuses = [
    { ...mygoWindow({ pageProcess: 902, documents: [] }), window: "w1" },
    { ...mygoWindow({ documents: [{ surface: "tab-2", document: "doc-1", process: 903 }, { surface: "tab-3", document: "doc-2", process: 0 }] }), window: "w2" },
  ];
  assert.deepEqual(await windowApplicationRows({ configDir: MYGO, statuses, run, realpath: (path) => path }), {
    rows: [
      { role: "host", pid: 10, attribution: "config-dir argument" },
      { role: "sidecar probe", pid: 11, attribution: "executable path" },
      { role: "page w1", pid: 902, attribution: "host.window" },
      { role: "document tab-2/doc-1", pid: 903, attribution: "host.window" },
      { role: "webkit gpu", pid: 300, attribution: "launchd domain" },
    ],
    errors: [`document tab-3/doc-2 of window w2 of ${MYGO}: no process (0)`],
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
    conditions: { refreshRate: 120, backingScale: 2, traceState: false, logPolicy: POLICY, window: { width: 1200, height: 760 } },
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
  assert.deepEqual(output.conditions, { refreshRate: 120, backingScale: 2, traceState: false, logPolicy: POLICY, window: { width: 1200, height: 760 } });
  assert.equal(output.measurements.hostCpuSeconds, 0.12);
  assert.equal(usageOutput({ options: { trace: 1 }, measurement }).conditions.traceState, true);
  const folder = mkdtempSync(join(tmpdir(), "b3-usage-"));
  try {
    writeB3Out(join(folder, "S1.json"), output);
    assert.deepEqual(readB3Out(join(folder, "S1.json")), output);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  const mixed = { ...measurement, marks: { ...measurement.marks, before: [{ ...measurement.marks.before[0], windows: [marksOfTwo().before[0], { ...marksOfTwo().before[1], scale: 1 }] }] } };
  assert.throws(() => usageOutput({ options: { trace: 0 }, measurement: mixed }), /window w2 reports refreshRate 120 and scale 1, not refreshRate 120 and scale 2 of window w1/);
});

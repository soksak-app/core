import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeViewGroup, openRecordedView, processStartSamples, viewContentFrameEvents,
  mapViewContentFramesToCapture, waitForViewReadiness, withViewContentTrace } from "../view-metrics-collection.mjs";

const event = (name, surface, ts_us, mono_ns) => ({ event: name, ts_us, mono_ns,
  fields: { plugin: "fixture", surface } });

test("generic view process samples preserve both event clocks and pair the first ready event", { timeout: 5000 }, () => {
  const rows = [event("host.trace.view.process-request", "view-1", 10, 1_000_000),
    event("host.trace.view.process-ready", "view-1", 20, 5_000_000)];
  assert.deepEqual(processStartSamples(rows, ["view-1"], "fixture"), [{
    requestAtMs: 1, readyAtMs: 5, requestTsUs: 10, readyTsUs: 20,
    requestMonoNs: 1_000_000, readyMonoNs: 5_000_000,
    requestEvent: rows[0], readyEvent: rows[1],
  }]);
  assert.throws(() => processStartSamples([rows[0]], ["view-1"], "fixture"), /no process-ready/);
  assert.throws(() => processStartSamples([rows[0], rows[0], rows[1]], ["view-1"], "fixture"), /duplicate process-request/);
  assert.throws(() => processStartSamples([rows[1], event("host.trace.view.process-request", "view-1", 30, 6_000_000)],
    ["view-1"], "fixture"), /precedes process-request/);
});

test("generic view content-frame events correlate page frames with the host clocks", { timeout: 5000 }, () => {
  const row = { event: "plugin.fixture.view.content_frame", ts_us: 2_000_000,
    mono_ns: 3_000_000, surface: "view-1", fields: { sequence: 4, documentTimeOriginMs: 1999,
      resizeAtMs: 0.2, frameTimeMs: 0.5, width: 300, height: 200 } };
  assert.deepEqual(viewContentFrameEvents([row], "fixture", "view-1"), [{
    sequence: 4, width: 300, height: 200, resizeAtMs: 0.2, frameTimeMs: 0.5,
    sourceTimeMs: 1999.5, timeMs: 2.5, hostArrivalTimeMs: 3, wallCorrelationMs: 0.5,
    source: { documentTimeOriginMs: 1999, ts_us: 2_000_000, mono_ns: 3_000_000 },
  }]);
  assert.throws(() => viewContentFrameEvents([{ ...row, mono_ns: 0 }], "fixture", "view-1"), /mono_ns/);
  assert.throws(() => viewContentFrameEvents([{ ...row, fields: { ...row.fields, width: 0 } }], "fixture", "view-1"), /width/);
});

test("generic view content-frame events accept the SDK's initial zero sequence", { timeout: 5000 }, () => {
  const rows = [0, 1].map((sequence, index) => ({ event: "plugin.fixture.view.content_frame",
    ts_us: 2_000_000 + index, mono_ns: 3_000_000 + index, surface: "view-1",
    fields: { sequence, documentTimeOriginMs: 1999, resizeAtMs: 0.2 + index,
      frameTimeMs: 0.5 + index, width: 300, height: 200 } }));
  assert.deepEqual(viewContentFrameEvents(rows, "fixture", "view-1").map(({ sequence }) => sequence), [0, 1]);
});

test("view cadence uses source frame times instead of variable host IPC arrival intervals", { timeout: 5000 }, () => {
  const rows = [1, 2].map((sequence, index) => ({ event: "plugin.fixture.view.content_frame",
    ts_us: 2_100_000 + index * 100_000, mono_ns: 1_100_000_000 + index * 100_000_000,
    surface: "view-1", fields: { sequence, documentTimeOriginMs: 1999,
      resizeAtMs: 1 + index * 16, frameTimeMs: 1 + index * 16, width: 300, height: 200 } }));
  const frames = viewContentFrameEvents(rows, "fixture", "view-1");
  assert.equal(frames[1].timeMs - frames[0].timeMs, 16);
  assert.equal(frames[1].hostArrivalTimeMs - frames[0].hostArrivalTimeMs, 100);
  assert.equal(frames[1].source.mono_ns - frames[0].source.mono_ns, 100_000_000);
});

test("generic source-frame mapping preserves multiple events per capture frame", { timeout: 5000 }, () => {
  const source = [
    { sequence: 0, timeMs: 8, width: 299, height: 200 },
    { sequence: 1, timeMs: 10, width: 300, height: 200 },
    { sequence: 2, timeMs: 11, width: 301, height: 200 },
    { sequence: 3, timeMs: 12, width: 302, height: 200 },
    { sequence: 4, timeMs: 21, width: 303, height: 200 },
  ];
  const captured = [{ time: 9 }, { time: 15 }, { time: 20 }];
  assert.deepEqual(mapViewContentFramesToCapture(source, captured), [
    { ...source[0], sourceSequence: 0, frameIndex: null },
    { ...source[1], sourceSequence: 1, frameIndex: 1 },
    { ...source[2], sourceSequence: 2, frameIndex: 1 },
    { ...source[3], sourceSequence: 3, frameIndex: 1 },
    { ...source[4], sourceSequence: 4, frameIndex: null },
  ]);
});

test("generic content trace starts before an action and returns only scoped source events", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "view-content-trace-"));
  const logs = join(root, "logs");
  mkdirSync(logs);
  writeFileSync(join(logs, "host-1-1.jsonl"), "");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const s = { app: { configDir: root }, async flushLog() {} };
  const descriptor = {
    plugin: "fixture",
    async startContentTrace(session, surface) { calls.push(["start", session, surface]); },
    async stopContentTrace(session, surface) { calls.push(["stop", session, surface]); return { sequence: 1 }; },
  };
  const result = await withViewContentTrace({ diagnostic() {} }, s, descriptor, "view-1", async () => {
    calls.push(["action"]);
    appendFileSync(join(logs, "host-1-1.jsonl"), `${JSON.stringify({ level: "debug", event:
      "plugin.fixture.view.content_frame", ts_us: 2_000_000, mono_ns: 3_000_000, seq: 1,
      surface: "view-1", fields: { sequence: 1, documentTimeOriginMs: 1999, resizeAtMs: 0.2,
        frameTimeMs: 0.5, width: 300, height: 200 } })}\n`);
    return { gestureEndedAtMs: 2 };
  });
  assert.deepEqual(calls.map(([name]) => name), ["start", "action", "stop"]);
  assert.deepEqual(result.action, { gestureEndedAtMs: 2 });
  assert.deepEqual(result.contentFrames.map(({ sequence, width, height }) => ({ sequence, width, height })),
    [{ sequence: 1, width: 300, height: 200 }]);
  assert.deepEqual(result.stop, { sequence: 1 });
});

test("shared readiness wrapper waits for the declared status exposure before reading it", { timeout: 5000 }, async () => {
  const calls = [];
  let registered = false;
  let releaseExposure;
  let signalWaitStarted;
  let signalReadinessStarted;
  const exposureNotification = new Promise((resolve) => { releaseExposure = resolve; });
  const waitStarted = new Promise((resolve) => { signalWaitStarted = resolve; });
  const readinessStarted = new Promise((resolve) => { signalReadinessStarted = resolve; });
  const session = {
    async until(name, predicate, message) {
      calls.push(`until:${name}`);
      signalWaitStarted();
      await exposureNotification;
      registered = true;
      const surfaces = [{ surface: "view-a", exposes: ["status fixture.ready"] }];
      assert.ok(predicate(surfaces), message);
      return surfaces;
    },
  };
  const readiness = waitForViewReadiness(session, "view-a", {
    readinessStatus: "fixture.ready",
    async readiness() {
      calls.push("readiness");
      signalReadinessStarted();
      assert.equal(registered, true, "readiness ran before the exposed status notification");
      return "ready";
    },
  });
  const outcome = readiness.then((value) => ({ value }), (error) => ({ error }));
  const firstStep = await Promise.race([waitStarted.then(() => "wait"), readinessStarted.then(() => "readiness")]);
  assert.equal(firstStep, "wait", "readiness ran before waiting for status exposure");
  assert.deepEqual(calls, ["until:core.surfaces"]);
  releaseExposure();
  const { value, error } = await outcome;
  if (error) throw error;
  assert.equal(value, "ready");
  assert.deepEqual(calls, ["until:core.surfaces", "readiness"]);
});

test("opening a view records before creation and proves pixels from a finalized frame", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "view-metrics-session-"));
  const logDirectory = join(root, "logs");
  const recordingDirectory = join(root, "recording");
  mkdirSync(logDirectory);
  mkdirSync(recordingDirectory);
  writeFileSync(join(logDirectory, "host-1-1.jsonl"), "");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const pixels = Buffer.from([1, 2, 3, 255]);
  const frame = Buffer.alloc(80);
  frame.writeUInt32LE(1, 0);
  frame.writeUInt32LE(1, 4);
  frame.writeUInt32LE(4, 8);
  [0, 0, 1, 1, 1, 1, 10].forEach((value, index) => frame.writeDoubleLE(value, 12 + index * 8));
  frame.write("LZ4B", 68, "ascii");
  frame.writeUInt32LE(5, 72);
  frame.writeUInt32LE(crc32(pixels), 76);
  writeFileSync(join(recordingDirectory, "frame-0.bgra"), Buffer.concat([frame, Buffer.from([0x40]), pixels]));

  const calls = [];
  let viewOpen = true;
  let exposureRegistered = false;
  let releaseExposure;
  let signalExposureWait;
  const exposureWaitStarted = new Promise((resolve) => { signalExposureWait = resolve; });
  const exposureNotification = new Promise((resolve) => { releaseExposure = resolve; });
  let signalReadiness;
  const readinessStarted = new Promise((resolve) => { signalReadiness = resolve; });
  let readinessCalls = 0;
  const s = {
    async get(name) {
      assert.equal(name, "host.window");
      return { documents: [{ surface: "view-1", document: "", process: 4101 }] };
    },
    app: { configDir: root },
    async record() { calls.push("record"); return { frames: recordingDirectory, stop: async () => {
      calls.push("stop"); return { frames: recordingDirectory, count: 1, limited: false };
    } }; },
    async request(method) { calls.push(method); return { mono_ns: "1000000000" }; },
    async run(method, params) {
      calls.push(method);
      assert.deepEqual(params, { card: "card-1", plugin: "fixture", params: { path: "file.txt" } });
      appendFileSync(join(logDirectory, "host-1-1.jsonl"), `${JSON.stringify({ level: "debug", event:
        "host.trace.view.process-request", ts_us: 1000, mono_ns: 1_000_000_000, seq: 1,
        fields: { plugin: "fixture", surface: "view-1" } })}\n${JSON.stringify({ level: "debug", event:
        "host.trace.view.process-ready", ts_us: 2000, mono_ns: 2_000_000_000, seq: 2,
        fields: { plugin: "fixture", surface: "view-1" } })}\n`);
      return { tab: "view-1" };
    },
    async until(name, predicate, message, options) {
      calls.push(["until", name, options]);
      if (!exposureRegistered) {
        assert.equal(name, "core.surfaces");
        signalExposureWait();
        await exposureNotification;
        exposureRegistered = true;
        const value = [{ surface: "view-1", exposes: ["status fixture.ready"] }];
        assert.ok(predicate(value), message);
        return value;
      }
      const value = viewOpen ? [{ surface: "view-1", exposes: ["status fixture.ready"] }] : [];
      assert.ok(predicate(value), message);
      return value;
    },
    async presented() { return { displayed: 10 }; },
    async get(name) {
      if (name === "core.surfaces") return viewOpen ? [{ surface: "view-1" }] : [];
      assert.equal(name, "host.window");
      return { documents: [{ surface: "view-1", document: "", visible: true, process: 3141,
        frame: { x: 0, y: 0, width: 1, height: 1 } }] };
    },
    cleanup(fn) { calls.push("cleanup"); this.cleanups ??= []; this.cleanups.push(fn); },
  };
  const opening = openRecordedView({ diagnostic: () => {} }, s, {
    card: "card-1", plugin: "fixture", params: { path: "file.txt" },
    readinessStatus: "fixture.ready",
    readiness: async (_session, surface) => {
      signalReadiness();
      assert.equal(exposureRegistered, true, "status read began before its exposure registration notification");
      readinessCalls++;
      assert.equal(surface, "view-1");
    },
    expectedContent: "SOKSAK FIXTURE", language: "en-US",
    recognizeFrame: async (decoded, rect, language) => {
      assert.equal(decoded.time, 10);
      assert.deepEqual(rect, { x: 0, y: 0, w: 1, h: 1 });
      assert.equal(language, "en-US");
      return { lines: ["SOKSAK FIXTURE"] };
    },
  });
  const openingResult = opening.then((value) => ({ value }), (error) => ({ error }));
  const firstStep = await Promise.race([
    exposureWaitStarted.then(() => "exposure-wait"),
    readinessStarted.then(() => "readiness"),
  ]);
  assert.equal(firstStep, "exposure-wait", "status readiness began before waiting for exposure registration");
  assert.equal(readinessCalls, 0, "status readiness ran before its exposure was registered");
  releaseExposure();
  const { value: result, error } = await openingResult;
  if (error) throw error;
  assert.equal(calls.indexOf("record") < calls.indexOf("core.card.add-tab"), true);
  assert.equal(result.surface, "view-1");
  assert.equal(result.openedPid, 3141);
  assert.deepEqual(result.contentFrame, { frameIndex: 0, frameCount: 1, timeMs: 10,
    proof: { expected: "SOKSAK FIXTURE", actual: "SOKSAK FIXTURE", lines: ["SOKSAK FIXTURE"] } });
  assert.equal(s.cleanups.length, 1, "the opened view had no cleanup owner");
  s.run = async (method) => {
    assert.equal(method, "core.tab.close");
    viewOpen = false;
    return { closed: true };
  };
  await s.cleanups[0]();
});

test("view process-group close records observed history and every original PID", { timeout: 5000 }, async () => {
  const calls = [];
  let clock = 1_000_000_000;
  const s = {
    async get(name) {
      assert.equal(name, "host.window");
      return { documents: [{ surface: "view-1", document: "", process: 4101 }] };
    },
    async request(method, params) {
      calls.push([method, params]);
      if (method === "diagnostics.clock") { clock += 1_000_000; return { mono_ns: String(clock) }; }
      assert.equal(method, "diagnostics.process.exit");
      return null;
    },
    async run(method, params) { calls.push([method, params]); return { closed: true }; },
    async until(name, predicate) { assert.equal(name, "core.surfaces"); assert.ok(predicate([])); return []; },
  };
  const beforeProcesses = [{ pid: 4101, footprintBytes: 1_000_000 }];
  const closedViews = [{ surface: "view-1", rootHistoryEntries: 1, documents: [] }];
  const result = await closeViewGroup({ diagnostic() {} }, s, { surfaces: ["view-1"], beforeProcesses, closedViews });
  assert.deepEqual(result, { beforeProcesses, afterProcesses: [{ pid: 4101, footprintBytes: 0 }],
    elapsedMs: 1, engineCacheHeld: false, closedViews });
  await assert.rejects(closeViewGroup({ diagnostic() {} }, s, {
    surfaces: ["view-1"], beforeProcesses,
    closedViews: [{ surface: "view-1", rootHistoryEntries: 2, documents: [] }],
  }), /root session history/);
});

test("source events inside the gesture require a recorded capture frame", { timeout: 5000 }, async () => {
  const { requireViewContentFrameCoverage } = await import("../view-metrics-collection.mjs");
  assert.deepEqual(requireViewContentFrameCoverage([
    { sequence: 0, sourceSequence: 0, timeMs: 8, frameIndex: null },
    { sequence: 1, sourceSequence: 1, timeMs: 10, frameIndex: 1 },
    { sequence: 2, sourceSequence: 2, timeMs: 21, frameIndex: null },
  ], { gestureStartedAtMs: 9, gestureEndedAtMs: 20 }), [
    { sequence: 1, sourceSequence: 1, timeMs: 10, frameIndex: 1 },
  ]);
  assert.throws(() => requireViewContentFrameCoverage([
    { sequence: 1, sourceSequence: 1, timeMs: 10, frameIndex: null },
  ], { gestureStartedAtMs: 9, gestureEndedAtMs: 20 }), /inside the gesture has no capture frame/);
});

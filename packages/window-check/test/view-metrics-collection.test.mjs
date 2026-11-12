import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stillFrame, stillFields } from "../still-recording.mjs";
import { policyOfSetting, readPolicy } from "../log-policy.mjs";
import * as viewMetrics from "../view-metrics-collection.mjs";
import { closeViewGroup, collectViewProcessGroups, collectViewReclaimMeasurements, collectViewStartAndMemory, openRecordedView,
  processStartSamples, TAB_PLACEMENT, viewContentFrameEvents, viewCardWithDifferentPluginTab,
  viewStartClockBracket, waitForViewReadiness, withDragTraceMode, withViewContentTrace } from "../view-metrics-collection.mjs";

const event = (name, surface, ts_us, mono_ns) => ({ event: name, ts_us, mono_ns,
  fields: { plugin: "fixture", surface } });

function sourceResult(documentTimeOriginMs = 1999, sourceNowMs = 0.2) {
  return { enabled: true, sourceClock: { documentTimeOriginMs, sourceNowMs, sourceResolutionMs: 1 } };
}

function clockReading(monoNs) {
  return { monoNs: String(monoNs), timeMs: Number(BigInt(monoNs)) / 1_000_000 };
}

function startBracket({ surface = "view-1", documentTimeOriginMs = 1999, sourceNowMs = 0.2,
  beforeMonoNs = 1_000_000_000, afterMonoNs = 1_001_000_000, hostPid = 41, window = "main", startResult } = {}) {
  const result = startResult ?? sourceResult(documentTimeOriginMs, sourceNowMs);
  return viewStartClockBracket(surface, result, clockReading(beforeMonoNs), clockReading(afterMonoNs), { hostPid, window });
}

// Each clock read advances 10 ms unless clockValues names the readings; the document clock reads 0.2 ms of time origin 1999.
function traceSession(root, calls, { clockValues, hostPid = 41, window = "main", documentClock = () => ({ page: "page-1", timeOrigin: 1999, now: 0.2 }) } = {}) {
  const client = { endpoint: { pid: hostPid } };
  let nextClock = 0;
  return {
    app: { configDir: root }, client, window,
    async request(method, params) {
      calls.push("clock");
      assert.equal(method, "diagnostics.clock");
      assert.deepEqual(params, {});
      const value = clockValues ? clockValues[nextClock++] : String(1_000_000_000 + 10_000_000 * nextClock++);
      if (value instanceof Error) throw value;
      return { mono_ns: value };
    },
    async run(name, params, surface) {
      calls.push("read");
      assert.deepEqual([name, params, surface], ["core.surface.clock", {}, "view-1"]);
      return documentClock();
    },
    async flushLog() { calls.push("flush"); },
  };
}

// The five clock reads after the start of a trace, each between two native clock reads.
const CLOCK_READS = Array.from({ length: 5 }, () => ["clock", "read", "clock"]).flat();

/** Writes still `index` of a recording, requested at `time` (ms) and completed 0.5ms later. */
function writeCapturedFrame(directory, index, time) {
  writeFileSync(join(directory, `frame-${String(index).padStart(4, "0")}.bgra`), stillFrame(time, time + 0.5));
}

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

test("view anchor selection prefers the requested card and finds another card when needed", { timeout: 5000 }, () => {
  const grid = { cards: [
    { id: "target", active: "same", tabs: [{ id: "same", plugin: "fixture" }] },
    { id: "anchor", active: "other", tabs: [{ id: "other", plugin: "other-fixture" }] },
    { id: "preferred", active: "target-2", tabs: [
      { id: "target-2", plugin: "fixture" }, { id: "anchor-2", plugin: "other-fixture" },
    ] },
  ] };
  assert.equal(viewCardWithDifferentPluginTab(grid, "fixture", "preferred"), "preferred");
  assert.equal(viewCardWithDifferentPluginTab(grid, "fixture", "target"), "anchor");
  assert.throws(() => viewCardWithDifferentPluginTab({ cards: [{ id: "only", tabs: [
    { id: "same", plugin: "fixture" },
  ] }] }, "fixture"), /no card with an open plugin other than fixture/);
});

test("shared width drag plan uses the scratch card right boundary", { timeout: 5000 }, () => {
  const grid = { lines: { x: [0, 196, 503, 970, 1186] } };
  const card = { c0: 2, c1: 3 };
  const rightSidebar = { c0: 3, c1: 4, fixed: true };
  assert.equal(typeof viewMetrics.rightEdgeWidthDragPlan, "function",
    "the shared view collector does not expose its right-edge width drag plan");
  const plan = viewMetrics.rightEdgeWidthDragPlan(grid, card);
  assert.deepEqual(plan, { axis: "x", line: 3, dx: 80, dy: 0, ms: 500, times: 1 });
  assert.ok(plan.line > card.c0 && plan.line < grid.lines.x.length - 1,
    "the width drag must use the scratch card's interior right boundary");
  assert.equal(plan.line, rightSidebar.c0,
    "the width drag must move the boundary between the scratch card and fixed right sidebar");
  assert.notEqual(plan.line, 1, "line 1 is outside the actual c2-c3 scratch card");
});

test("shared width drag plan rejects invalid card boundaries", { timeout: 5000 }, () => {
  assert.equal(typeof viewMetrics.rightEdgeWidthDragPlan, "function",
    "the shared view collector does not expose its right-edge width drag plan");
  const grid = { lines: { x: [0, 196, 583, 970, 1186] } };
  assert.throws(() => viewMetrics.rightEdgeWidthDragPlan(grid, { c0: 3, c1: 2 }), /ordered grid columns/);
  assert.throws(() => viewMetrics.rightEdgeWidthDragPlan(grid, { c0: 2, c1: 4 }), /interior horizontal boundary/);
});

test("the exported lifecycle collector forwards the selected card ID to its first recording", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "view-card-forwarding-"));
  const logDirectory = join(root, "logs");
  mkdirSync(logDirectory);
  writeFileSync(join(logDirectory, "host-1-1.jsonl"), "");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sentinel = new Error("record sentinel reached with the selected card");
  let recordCalls = 0;
  const card = { id: "selected-card", active: "anchor", tabs: [
    { id: "anchor", plugin: "other-fixture" }, { id: "old-target", plugin: "fixture" },
  ] };
  const s = {
    app: { configDir: root },
    async get(name) { assert.equal(name, "core.grid"); return { cards: [card] }; },
    async record() { recordCalls++; throw sentinel; },
  };
  await assert.rejects(collectViewStartAndMemory(t, s, {
    plugin: "fixture", placement: TAB_PLACEMENT, readinessStatus: "fixture.ready", readiness: async () => {},
    expectedContent: "target text", readContent: async () => "target text",
  }), (error) => error === sentinel);
  assert.equal(recordCalls, 1, "the selected card ID did not reach openRecordedView before recording");
});

test("view totals are sampled at their declared count before extra process-start views open", { timeout: 5000 }, async () => {
  let openedCount = 0;
  const timeline = [];
  const sampleClock = (number) => ({
    before: clockReading(number * 1_000_000),
    after: clockReading((number + 1) * 1_000_000),
  });
  const collected = await collectViewProcessGroups({
    viewCount: 3,
    processStartCount: 5,
    diagnostic: () => {},
    async openView() {
      const ordinal = ++openedCount;
      const surface = `view-${ordinal}`;
      timeline.push(`live:${ordinal}`);
      const base = ordinal * 10;
      return { surface, events: [
        { event: "host.trace.view.process-request", ts_us: base, mono_ns: base * 1_000_000,
          fields: { plugin: "fixture", surface } },
        { event: "host.trace.view.process-ready", ts_us: base + 1, mono_ns: (base + 1) * 1_000_000,
          fields: { plugin: "fixture", surface } },
      ], verifyContent: async () => { timeline.push(`content:${ordinal}`);
        return { contentFrame: { frameIndex: 0, timeMs: base } }; } };
    },
    async readFootprints(surfaces) {
      timeline.push(`footprint:${openedCount}`);
      assert.deepEqual(surfaces, Array.from({ length: openedCount }, (_, index) => `view-${index + 1}`));
      return { processes: surfaces.map((surface, index) => ({ pid: index + 1, footprintBytes: 100 })),
        sampleClock: sampleClock(openedCount) };
    },
  });

  assert.deepEqual(timeline, ["live:1", "footprint:1", "live:2", "live:3", "footprint:3",
    "live:4", "live:5", "content:1", "content:2", "content:3", "content:4", "content:5"],
  "the content frame selection must follow both total-footprint samples and the five process-start view opens");
  assert.deepEqual(collected.oneViewSampleClock, sampleClock(1));
  assert.deepEqual(collected.allViewSampleClock, sampleClock(3));
  assert.deepEqual(collected.opened.map(({ contentFrame }) => contentFrame.frameIndex), [0, 0, 0, 0, 0]);
  assert.equal(collected.opened.length, 5, "the collector must retain all five process-start samples");
  assert.equal(processStartSamples(collected.events, collected.opened.map(({ surface }) => surface), "fixture").length, 5,
    "the extra views must still provide all five process-start samples");
});

test("footprint failure retains recording paths and skips the deferred content frame", { timeout: 5000 }, async () => {
  const sentinel = new Error("footprint read failed");
  const diagnostics = [];
  let contentCalls = 0;
  await assert.rejects(collectViewProcessGroups({
    viewCount: 3,
    processStartCount: 5,
    diagnostic: (message) => diagnostics.push(message),
    async openView() {
      return { surface: "view-1", events: [], recording: { directory: "/retained/view-1" },
        async verifyContent() { contentCalls++; return { contentFrame: {} }; } };
    },
    async readFootprints() { throw sentinel; },
  }), (error) => error === sentinel);
  assert.equal(contentCalls, 0, "footprint failure must not select the content frame");
  assert.match(diagnostics[0], /footprint read failed/);
  assert.deepEqual(diagnostics.slice(1), ["view recording retained at /retained/view-1 after one-view footprint sample failure"]);
});

test("deferred content frame failure retains its recording path and rejects the collector", { timeout: 5000 }, async () => {
  const sentinel = new Error("content frame selection failed");
  const diagnostics = [];
  let ordinal = 0;
  await assert.rejects(collectViewProcessGroups({
    viewCount: 2,
    processStartCount: 2,
    diagnostic: (message) => diagnostics.push(message),
    async openView() {
      const surface = `view-${++ordinal}`;
      return { surface, events: [], recording: { directory: `/retained/${surface}` },
        async verifyContent() {
          if (surface === "view-1") throw sentinel;
          return { contentFrame: { frameIndex: 0 } };
        } };
    },
    async readFootprints(surfaces) {
      return { processes: surfaces.map((_, index) => ({ pid: index + 1, footprintBytes: 100 })),
        sampleClock: { before: clockReading(1_000_000), after: clockReading(2_000_000) } };
    },
  }), (error) => error === sentinel);
  assert.match(diagnostics[0], /content frame selection failed/);
  assert.deepEqual(diagnostics.slice(1), ["view recording retained at /retained/view-1 after deferred content verification failure",
    "view recording retained at /retained/view-2 after deferred content verification failure"]);
});

test("view content-frame events preserve coalesced resize provenance", { timeout: 5000 }, () => {
  const row = { event: "plugin.fixture.view.content_frame", ts_us: 2_000_000,
    mono_ns: 3_000_000, page: "view-document-opaque", surface: "view-1", fields: { sequence: 0, documentTimeOriginMs: 1999,
      firstResizeAtMs: 0.1, resizeAtMs: 0.2, resizeCount: 2, frameTimeMs: 0.5, width: 300, height: 200 } };
  const anchor = startBracket();
  const [frame] = viewContentFrameEvents([row], "fixture", "view-1", anchor);
  assert.deepEqual({ firstResizeAtMs: frame.firstResizeAtMs, resizeAtMs: frame.resizeAtMs,
    resizeCount: frame.resizeCount }, { firstResizeAtMs: 0.1, resizeAtMs: 0.2, resizeCount: 2 });
  for (const fields of [
    { ...row.fields, firstResizeAtMs: undefined },
    { ...row.fields, firstResizeAtMs: 0.3 },
    { ...row.fields, resizeCount: 0 },
    { ...row.fields, resizeCount: 1.5 },
    { ...row.fields, resizeCount: 1 },
  ]) {
    assert.throws(() => viewContentFrameEvents([{ ...row, fields }], "fixture", "view-1", anchor),
      /firstResizeAtMs|resizeCount/);
  }
});

test("generic view content-frame events use the start source clock and preserve its interval", { timeout: 5000 }, () => {
  const row = { event: "plugin.fixture.view.content_frame", ts_us: 2_000_000,
    mono_ns: 3_000_000, page: "view-document-opaque", surface: "view-1", fields: { sequence: 4, documentTimeOriginMs: 1999,
      firstResizeAtMs: 0.2, resizeAtMs: 0.2, resizeCount: 1, frameTimeMs: 0.5, width: 300, height: 200 } };
  assert.deepEqual(viewContentFrameEvents([row], "fixture", "view-1", startBracket()), [{
    sequence: 4, width: 300, height: 200, firstResizeAtMs: 0.2, resizeAtMs: 0.2, resizeCount: 1, frameTimeMs: 0.5,
    timeRange: { lowerMs: 998.3, upperMs: 1003.3 },
    source: { documentTimeOriginMs: 1999, frameTimeMs: 0.5, sourceNowMs: 0.2, sourceResolutionMs: 1,
      clockBeforeMonoNs: "1000000000", clockAfterMonoNs: "1001000000", clockBeforeMs: 1000, clockAfterMs: 1001,
      hostPid: 41, window: "main", surface: "view-1", eventTsUs: 2_000_000, eventMonoNs: 3_000_000,
      eventPage: "view-document-opaque" },
  }]);
  assert.throws(() => viewContentFrameEvents([{ ...row, mono_ns: 0 }], "fixture", "view-1", startBracket()), /mono_ns/);
  assert.throws(() => viewContentFrameEvents([{ ...row, fields: { ...row.fields, width: 0 } }], "fixture", "view-1", startBracket()), /width/);
});

test("view content-frame mapping uses the successful start's native clock bracket", { timeout: 5000 }, () => {
  const row = { event: "plugin.fixture.view.content_frame", ts_us: 9_000_000,
    mono_ns: 99_000_000_000, page: "view-document-opaque", surface: "view-1", fields: { sequence: 0, documentTimeOriginMs: 1000,
      firstResizeAtMs: 10, resizeAtMs: 10, resizeCount: 1, frameTimeMs: 30, width: 300, height: 200 } };
  const bracket = startBracket({ documentTimeOriginMs: 1000, sourceNowMs: 20, afterMonoNs: 1_002_000_000 });
  assert.deepEqual(viewContentFrameEvents([row], "fixture", "view-1", bracket), [{
    sequence: 0, width: 300, height: 200, firstResizeAtMs: 10, resizeAtMs: 10, resizeCount: 1, frameTimeMs: 30,
    timeRange: { lowerMs: 1008, upperMs: 1014 },
    source: { documentTimeOriginMs: 1000, frameTimeMs: 30, sourceNowMs: 20, sourceResolutionMs: 1,
      clockBeforeMonoNs: "1000000000", clockAfterMonoNs: "1002000000", clockBeforeMs: 1000, clockAfterMs: 1002,
      hostPid: 41, window: "main", surface: "view-1",
      eventTsUs: 9_000_000, eventMonoNs: 99_000_000_000, eventPage: "view-document-opaque" },
  }]);
});

test("view start clock brackets require valid source identity and ordered native clock replies", { timeout: 5000 }, () => {
  const result = sourceResult();
  const bracket = startBracket({ startResult: result });
  assert.deepEqual(bracket, { surface: "view-1", hostPid: 41, window: "main", sourceClock: result.sourceClock,
    before: { monoNs: "1000000000", timeMs: 1000 }, after: { monoNs: "1001000000", timeMs: 1001 } });
  assert.throws(() => startBracket({ startResult: { enabled: true } }), /no sourceClock anchor/);
  assert.throws(() => startBracket({ startResult: { sourceClock: { ...result.sourceClock, extra: true } } }), /exactly the declared anchor fields/);
  assert.throws(() => startBracket({ startResult: { sourceClock: { ...result.sourceClock, sourceResolutionMs: 2 } } }), /declared 1 ms WebKit bound/);
  assert.throws(() => viewStartClockBracket("view-1", result, clockReading(2_000_000), clockReading(1_000_000),
    { hostPid: 41, window: "main" }), /must be later/);
  assert.throws(() => viewStartClockBracket("view-1", result, { monoNs: "01000000", timeMs: 1 }, clockReading(2_000_000),
    { hostPid: 41, window: "main" }), /invalid raw monotonic/);
  assert.throws(() => viewStartClockBracket("view-1", result, clockReading(1_000_000), clockReading(2_000_000),
    { hostPid: 0, window: "main" }), /process PID/);
  assert.throws(() => viewStartClockBracket("view-1", result, clockReading(1_000_000), clockReading(2_000_000),
    { hostPid: 41, window: "" }), /target window/);
});

test("generic view content-frame events accept the SDK's initial zero sequence", { timeout: 5000 }, () => {
  const rows = [0, 1].map((sequence, index) => ({ event: "plugin.fixture.view.content_frame",
    ts_us: 2_000_000 + index, mono_ns: 3_000_000 + index, page: "view-document-opaque", surface: "view-1",
    fields: { sequence, documentTimeOriginMs: 1999, firstResizeAtMs: 0.2 + index, resizeAtMs: 0.2 + index, resizeCount: 1,
      frameTimeMs: 0.5 + index, width: 300, height: 200 } }));
  assert.deepEqual(viewContentFrameEvents(rows, "fixture", "view-1", startBracket()).map(({ sequence }) => sequence), [0, 1]);
});

test("view cadence uses source frame times instead of variable host IPC arrival intervals", { timeout: 5000 }, () => {
  const rows = [1, 2].map((sequence, index) => ({ event: "plugin.fixture.view.content_frame", page: "view-document-opaque",
    ts_us: 2_100_000 + index * 100_000, mono_ns: 1_100_000_000 + index * 100_000_000,
    surface: "view-1", fields: { sequence, documentTimeOriginMs: 1999,
      firstResizeAtMs: 1 + index * 16, resizeAtMs: 1 + index * 16, resizeCount: 1, frameTimeMs: 1 + index * 16, width: 300, height: 200 } }));
  const frames = viewContentFrameEvents(rows, "fixture", "view-1", startBracket({ sourceNowMs: 0.2 }));
  assert.equal(frames[1].frameTimeMs - frames[0].frameTimeMs, 16);
  assert.equal(frames[1].timeRange.lowerMs - frames[0].timeRange.lowerMs, 16);
  assert.equal(frames[1].source.eventMonoNs - frames[0].source.eventMonoNs, 100_000_000);
});

test("generic content trace brackets the successful start command with native clock reads", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "view-content-trace-"));
  const logs = join(root, "logs");
  mkdirSync(logs);
  writeFileSync(join(logs, "host-1-1.jsonl"), "");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let clock = 1_000_000_000n;
  const client = { endpoint: { pid: 41 } };
  const s = { app: { configDir: root }, client, window: "main",
    async request(method, params) {
      assert.equal(method, "diagnostics.clock");
      assert.deepEqual(params, {});
      calls.push(["clock", client, s.window]);
      const monoNs = String(clock);
      clock += 10_000_000n;
      return { mono_ns: monoNs };
    },
    async run(name, params, surface) {
      calls.push(["read", name, params, surface]);
      return { page: "page-1", timeOrigin: 1999, now: 0.2 };
    }, async flushLog() { calls.push(["flush"]); } };
  const descriptor = {
    plugin: "fixture",
    async startContentTrace(session, surface) {
      calls.push(["start", session, surface]);
      const result = { marker: { color: [255, 0, 255] }, sourceClock: { documentTimeOriginMs: 1999, sourceNowMs: 0.2, sourceResolutionMs: 1 } };
      return result;
    },
    async stopContentTrace(session, surface) { calls.push(["stop", session, surface]); return { sequence: 1 }; },
  };
  const result = await withViewContentTrace({ diagnostic() {} }, s, descriptor, "view-1", async (start) => {
    assert.deepEqual(start, { marker: { color: [255, 0, 255] },
      sourceClock: { documentTimeOriginMs: 1999, sourceNowMs: 0.2, sourceResolutionMs: 1 } });
    calls.push(["action"]);
    appendFileSync(join(logs, "host-1-1.jsonl"), `${JSON.stringify({ level: "debug", event:
      "plugin.fixture.view.content_frame", ts_us: 2_000_000, mono_ns: 3_000_000, page: "view-document-opaque", seq: 1,
      surface: "view-1", fields: { sequence: 1, documentTimeOriginMs: 1999, firstResizeAtMs: 0.2, resizeAtMs: 0.2, resizeCount: 1,
        frameTimeMs: 0.5, width: 300, height: 200 } })}\n`);
    return { gestureEndedAtMs: 2 };
  });
  assert.deepEqual(calls.map(([name]) => name), ["read", "clock", "start", "clock", ...CLOCK_READS, "action", "stop", "flush"]);
  assert.equal(result.startBracket.surface, "view-1");
  assert.equal(result.startBracket.window, "main");
  assert.equal(result.startBracket.hostPid, 41);
  assert.deepEqual(result.startBracket.before, { monoNs: "1000000000", timeMs: 1000 });
  assert.deepEqual(result.startBracket.after, { monoNs: "1010000000", timeMs: 1010 });
  assert.deepEqual(result.action, { gestureEndedAtMs: 2 });
  assert.deepEqual(result.start, { marker: { color: [255, 0, 255] },
    sourceClock: { documentTimeOriginMs: 1999, sourceNowMs: 0.2, sourceResolutionMs: 1 } });
  assert.deepEqual(result.contentFrames.map(({ sequence, width, height }) => ({ sequence, width, height })),
    [{ sequence: 1, width: 300, height: 200 }]);
  assert.deepEqual(result.stop, { sequence: 1 });
});

test("content trace maps document times through the narrowest clock bracket of the same document", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "view-content-trace-narrowest-"));
  mkdirSync(join(root, "logs"));
  writeFileSync(join(root, "logs", "host-1-1.jsonl"), "");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The start bracket is 30 ms wide; the third clock read is 2 ms wide and reads 40.5 ms on the document clock.
  const clockValues = ["1000000000", "1030000000",
    "1040000000", "1050000000", "1060000000", "1070000000", "1080000000", "1082000000",
    "1090000000", "1100000000", "1110000000", "1120000000"];
  const nows = [20, 30, 40.5, 50, 60];
  let read = 0;
  const calls = [];
  // WebKit derives performance.timeOrigin from the current wall clock at each read and reduces it to whole milliseconds, so one
  // document can report time origins one millisecond apart; the page identity names the document.
  const s = traceSession(root, calls, { clockValues,
    documentClock: () => (read === 0 && !calls.includes("start") ? { page: "page-1", timeOrigin: 1999, now: 19 }
      : { page: "page-1", timeOrigin: 1999 + (read % 2), now: nows[read++] }) });
  const descriptor = {
    plugin: "fixture",
    async startContentTrace() { calls.push("start"); return sourceResult(1999, 0.2); },
    async stopContentTrace() { calls.push("stop"); return {}; },
  };
  const result = await withViewContentTrace({ diagnostic() {} }, s, descriptor, "view-1", async () => { calls.push("action"); });
  assert.deepEqual(result.startBracket.before, clockReading(1080000000));
  assert.deepEqual(result.startBracket.after, clockReading(1082000000));
  assert.equal(result.startBracket.sourceClock.sourceNowMs, 40.5);
  assert.equal(result.startBracket.sourceClock.documentTimeOriginMs, 1999, "the bracket left the time origin of the trace start");

  const otherCalls = [];
  let otherRead = 0;
  const other = traceSession(root, otherCalls, { documentClock: () => ({ page: otherRead++ === 0 ? "page-1" : "page-2", timeOrigin: 1999, now: 1 }) });
  await assert.rejects(withViewContentTrace({ diagnostic() {} }, other, { ...descriptor,
    async startContentTrace() { otherCalls.push("start"); return sourceResult(1999, 0.2); },
    async stopContentTrace() { otherCalls.push("stop"); return {}; } }, "view-1", async () => {}),
  /core.surface.clock read another document than the trace start/);
  assert.deepEqual(otherCalls, ["read", "clock", "start", "clock", "clock", "read", "clock", "stop"], "a failed clock read stops the observer");
});

test("content trace stops its diagnostic marker when the recorded action fails", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "view-content-trace-failure-"));
  const logs = join(root, "logs");
  mkdirSync(logs);
  writeFileSync(join(logs, "host-1-1.jsonl"), "");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const s = traceSession(root, calls);
  const descriptor = {
    plugin: "fixture",
    async startContentTrace() {
      calls.push("start");
      const result = { marker: "active", sourceClock: { documentTimeOriginMs: 1999, sourceNowMs: 0.2, sourceResolutionMs: 1 } };
      return result;
    },
    async stopContentTrace() { calls.push("stop"); return { marker: null }; },
  };
  await assert.rejects(withViewContentTrace({ diagnostic() {} }, s, descriptor, "view-1", async () => {
    calls.push("action");
    throw new Error("controlled action failure");
  }), /controlled action failure/);
  assert.deepEqual(calls, ["read", "clock", "start", "clock", ...CLOCK_READS, "action", "stop", "flush"]);
});

test("content trace stops after a successful start returns invalid marker evidence", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "view-content-trace-invalid-start-"));
  const logs = join(root, "logs");
  mkdirSync(logs);
  writeFileSync(join(logs, "host-1-1.jsonl"), "");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const s = traceSession(root, calls);
  const descriptor = {
    plugin: "fixture",
    async startContentTrace() {
      calls.push("start");
      const result = { marker: null, sourceClock: { documentTimeOriginMs: 1999, sourceNowMs: 0.2, sourceResolutionMs: 1 } };
      return result;
    },
    async stopContentTrace() { calls.push("stop"); return { marker: null }; },
  };
  await assert.rejects(withViewContentTrace({ diagnostic() {} }, s, descriptor, "view-1", async (start) => {
    calls.push("action");
    assert.ok(start.marker, "marker reply is invalid");
  }), /marker reply is invalid/);
  assert.deepEqual(calls, ["read", "clock", "start", "clock", ...CLOCK_READS, "action", "stop", "flush"]);
});

test("content trace stops when a successful start reply has no valid source clock anchor", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "view-content-trace-invalid-clock-"));
  const logs = join(root, "logs");
  mkdirSync(logs);
  writeFileSync(join(logs, "host-1-1.jsonl"), "");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const s = traceSession(root, calls);
  const descriptor = {
    plugin: "fixture",
    async startContentTrace() {
      calls.push("start");
      return { enabled: true };
    },
    async stopContentTrace() { calls.push("stop"); return { enabled: false }; },
  };
  await assert.rejects(withViewContentTrace({ diagnostic() {} }, s, descriptor, "view-1", async () => {
    calls.push("action");
  }), /no sourceClock anchor/);
  assert.deepEqual(calls, ["read", "clock", "start", "clock", "stop"]);
});

test("content trace stops its observer when the post-start native clock read fails", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "view-content-trace-clock-failure-"));
  const logs = join(root, "logs");
  mkdirSync(logs);
  writeFileSync(join(logs, "host-1-1.jsonl"), "");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const s = traceSession(root, calls, { clockValues: ["1000000000", new Error("controlled post-start clock failure")] });
  const descriptor = {
    plugin: "fixture",
    async startContentTrace() {
      calls.push("start");
      return sourceResult();
    },
    async stopContentTrace() { calls.push("stop"); return { enabled: false }; },
  };

  await assert.rejects(withViewContentTrace({ diagnostic() {} }, s, descriptor, "view-1", async () => {
    calls.push("action");
  }), /controlled post-start clock failure/);
  assert.deepEqual(calls, ["read", "clock", "start", "clock", "stop"]);
});

test("content trace start failure does not read an after clock or stop an unstarted observer", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "view-content-trace-start-failure-"));
  const logs = join(root, "logs");
  mkdirSync(logs);
  writeFileSync(join(logs, "host-1-1.jsonl"), "");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const s = traceSession(root, calls);
  const descriptor = {
    plugin: "fixture",
    async startContentTrace() { calls.push("start"); throw new Error("controlled start failure"); },
    async stopContentTrace() { calls.push("stop"); return { enabled: false }; },
  };
  await assert.rejects(withViewContentTrace({ diagnostic() {} }, s, descriptor, "view-1", async () => {
    calls.push("action");
  }), /controlled start failure/);
  assert.deepEqual(calls, ["read", "clock", "start"]);
});

test("content trace bracket rejects a replaced client, changed host process or target window", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "view-content-trace-identity-change-"));
  const logs = join(root, "logs");
  mkdirSync(logs);
  writeFileSync(join(logs, "host-1-1.jsonl"), "");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const changes = [
    { name: "client", update(session) { session.client = { endpoint: { pid: 42 } }; }, error: /changed the session host client/ },
    { name: "host PID", update(session) { session.client.endpoint.pid = 42; }, error: /changed the host process/ },
    { name: "window", update(session) { session.window = "other-window"; }, error: /changed the target window/ },
  ];
  for (const { name, update, error } of changes) {
    const calls = [];
    const s = traceSession(root, calls);
    const descriptor = {
      plugin: "fixture",
      async startContentTrace(session) {
        calls.push("start");
        update(session);
        return sourceResult();
      },
      async stopContentTrace() { calls.push("stop"); return { enabled: false }; },
    };
    await assert.rejects(withViewContentTrace({ diagnostic() {} }, s, descriptor, "view-1", async () => {
      calls.push("action");
    }), (failure) => {
      assert.match(failure.message, error, `${name} change must fail its bracket`);
      return true;
    });
    assert.deepEqual(calls, ["read", "clock", "start", "clock", "stop"], `${name} change cleans up the observer`);
  }
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

test("recorded views require a reader of the content value", { timeout: 5000 }, async () => {
  let recorded = false;
  await assert.rejects(openRecordedView({}, { async record() { recorded = true; } }, {
    card: "card-1", plugin: "fixture", placement: TAB_PLACEMENT, readinessStatus: "fixture.ready", readiness: async () => {},
    expectedContent: "fixture",
  }), /view content reader callback is required/);
  assert.equal(recorded, false, "a view without a content reader started its recording");
});

test("recorded view observation window rejects nonpositive and nonfinite durations", { timeout: 5000 }, async () => {
  for (const captureObservationWindowMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(openRecordedView({}, {}, {
      card: "card-1", plugin: "fixture", placement: TAB_PLACEMENT, readinessStatus: "fixture.ready", readiness: async () => {},
      expectedContent: "fixture", readContent: async () => "fixture", captureObservationWindowMs,
    }), /finite positive duration/);
  }
});

/**
 * A session that opens view-1 in card-1 under a recording of stills planned and requested at frameTimes, then `missed` more
 * stills that failed, and presents it at displayed.
 */
function recordedViewSession(t, { frameTimes, displayed, missed = 0, calls = [] }) {
  const root = mkdtempSync(join(tmpdir(), "view-recorded-content-"));
  const logDirectory = join(root, "logs");
  const recordingDirectory = join(root, "recording");
  mkdirSync(logDirectory);
  mkdirSync(recordingDirectory);
  writeFileSync(join(logDirectory, "host-1-1.jsonl"), "");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let viewOpen = false;
  const s = {
    app: { configDir: root },
    cleanups: [],
    async record() {
      calls.push("record");
      return { stop: async ({ after }) => {
        calls.push(`stop after ${after}`);
        for (const [index, time] of frameTimes.entries()) writeCapturedFrame(recordingDirectory, index, time);
        const ns = (ms) => String(Math.round(ms * 1e6));
        const row = (index, time, written) => ({ index, planned: ns(time), requested: ns(time), completed: ns(time + 0.5),
          outcome: written ? "written" : "failed", error: written ? null : "the window server returned no image",
          frame: written ? `frame-${String(index).padStart(4, "0")}.bgra` : null, windows: [7], requestedGap: 1000,
          machTimebaseNumerator: 1, machTimebaseDenominator: 1, ...stillFields(written, ns(time + 0.5)) });
        const last = frameTimes.at(-1);
        const rows = [...frameTimes.map((time, index) => row(index, time, true)),
          ...Array.from({ length: missed }, (_, k) => row(frameTimes.length + k, last + k + 1, false))];
        const stills = join(recordingDirectory, "stills.jsonl");
        writeFileSync(stills, rows.map((item) => JSON.stringify(item)).join("\n") + "\n");
        return { frames: recordingDirectory, stills, count: frameTimes.length, missed, late: 0 };
      } };
    },
    async request(method) { calls.push(method); return { mono_ns: "5000000" }; },
    async run(method, params) {
      calls.push(method);
      if (method === "core.tab.close") { viewOpen = false; return { closed: true }; }
      assert.equal(method, "core.card.add-tab");
      assert.equal(params.card, "card-1");
      appendFileSync(join(logDirectory, "host-1-1.jsonl"), `${JSON.stringify({ level: "debug", event:
        "host.trace.view.process-request", ts_us: 10, mono_ns: 6_000_000, seq: 1,
        fields: { plugin: "fixture", surface: "view-1" } })}\n${JSON.stringify({ level: "debug", event:
        "host.trace.view.process-ready", ts_us: 20, mono_ns: 7_000_000, seq: 2,
        fields: { plugin: "fixture", surface: "view-1" } })}\n`);
      viewOpen = true;
      return { tab: "view-1" };
    },
    async until(name, predicate, message) {
      calls.push(`until ${name}`);
      const value = viewOpen ? [{ surface: "view-1", exposes: ["status fixture.ready"] }] : [];
      assert.ok(predicate(value), message);
      return value;
    },
    async presented() { calls.push("presented"); return { displayed }; },
    async get(name) {
      if (name === "core.surfaces") return viewOpen ? [{ surface: "view-1" }] : [];
      assert.equal(name, "host.window");
      return { documents: [
        { surface: "view-1", document: "", visible: true, process: 3141, frame: { x: 0, y: 0, width: 1, height: 1 } },
      ] };
    },
    cleanup(fn) { calls.push("cleanup"); this.cleanups.push(fn); },
  };
  return s;
}

test("direct recorded views take the display time of the presentation of the value as the content frame", { timeout: 5000 }, async (t) => {
  const s = recordedViewSession(t, { frameTimes: [4, 6], displayed: 5 });
  const result = await openRecordedView({ diagnostic() {} }, s, {
    card: "card-1", plugin: "fixture", placement: TAB_PLACEMENT, readinessStatus: "fixture.ready", readiness: async () => {},
    expectedContent: "target content", readContent: async () => "the target content line", captureObservationWindowMs: 1,
  });
  // The content frame is a number that the host reports, the display time of the presentation after the value holds the content; the
  // recording is the log of the open and no time of a still is read.
  assert.deepEqual(result.contentFrame, { timeMs: 5,
    proof: { method: "value", expected: "target content", actual: "the target content line" } });
  assert.equal("anchor" in result, false, "the recorded view still reports an anchor");
  assert.deepEqual(Object.keys(result.recording), ["directory"]);
});

test("a recorded view whose value lacks the expected content stops its recording and fails", { timeout: 5000 }, async (t) => {
  const calls = [];
  const s = recordedViewSession(t, { frameTimes: [4, 6], displayed: 5, calls });
  await assert.rejects(openRecordedView({ diagnostic() {} }, s, {
    card: "card-1", plugin: "fixture", placement: TAB_PLACEMENT, readinessStatus: "fixture.ready", readiness: async () => {},
    expectedContent: "target content", readContent: async () => "loading",
  }), /fixture view view-1 does not show "target content": "loading"/);
  assert.equal(calls.includes("presented"), false, "the window presentation was read for a view without its content");
  assert.ok(calls.includes("stop after 0"), `the failed view left its recording running: ${calls}`);
});

test("one recording reads the content value after readiness and defers the content frame past the footprint sample", { timeout: 5000 }, async (t) => {
  const calls = [];
  const s = recordedViewSession(t, { frameTimes: [0.5, 5.5, 10, 13], displayed: 12, calls });
  let readinessCalls = 0;
  const opening = openRecordedView({ diagnostic: () => {} }, s, {
    card: "card-1", plugin: "fixture", placement: TAB_PLACEMENT, params: { path: "file.txt" },
    readinessStatus: "fixture.ready",
    readiness: async (_session, surface) => {
      calls.push("readiness");
      readinessCalls++;
      assert.equal(surface, "view-1");
    },
    readContent: async (_session, surface) => {
      calls.push("read");
      assert.equal(surface, "view-1");
      return "SOKSAK FIXTURE";
    },
    expectedContent: "SOKSAK FIXTURE", captureObservationWindowMs: 20,
    deferContentVerification: true,
  });
  const result = await opening;
  assert.equal(readinessCalls, 1);
  assert.equal("contentFrame" in result, false, "the deferred content frame was selected before the footprint sample");
  calls.push("footprint sample");
  Object.assign(result, await result.verifyContent());
  const at = (name) => calls.indexOf(name);
  assert.ok(at("until core.surfaces") < at("readiness"), "status readiness began before waiting for its exposure");
  assert.ok(at("readiness") < at("read"), "the content value was read before the view was ready");
  assert.ok(at("read") < at("presented"), "the presentation that bounds the content frame preceded the value read");
  assert.ok(at("presented") < at("stop after 32"), `the observation window was not retained through its deadline: ${calls}`);
  assert.equal(at("record"), calls.lastIndexOf("record"), "one view lifecycle started multiple recordings");
  assert.equal(result.surface, "view-1");
  assert.equal(result.openedPid, 3141);
  assert.deepEqual(result.contentFrame, { timeMs: 12,
    proof: { method: "value", expected: "SOKSAK FIXTURE", actual: "SOKSAK FIXTURE" } });
  assert.equal(s.cleanups.length, 1, "the opened view had no cleanup owner");
  await s.cleanups[0]();
  assert.ok(calls.includes("core.tab.close"), "the cleanup did not close the opened view");
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
    async until(name, predicate) {
      if (name === "host.window") {
        const value = { documents: [], pagelessProcesses: [{ pid: 4101, ending: true }] };
        assert.ok(predicate(value));
        return value;
      }
      assert.equal(name, "core.surfaces"); assert.ok(predicate([])); return [];
    },
  };
  const beforeProcesses = [{ pid: 4101, footprintBytes: 1_000_000 }];
  const closedViews = [{ surface: "view-1", rootHistoryEntries: 1, documents: [] }];
  const result = await closeViewGroup({ diagnostic() {} }, s, { placement: TAB_PLACEMENT, surfaces: ["view-1"], beforeProcesses, closedViews });
  assert.deepEqual(result, { beforeProcesses, afterProcesses: [{ pid: 4101, footprintBytes: 0 }],
    elapsedMs: 1, engineCacheHeld: false, closedViews });
  await assert.rejects(closeViewGroup({ diagnostic() {} }, s, {
    placement: TAB_PLACEMENT, surfaces: ["view-1"], beforeProcesses,
    closedViews: [{ surface: "view-1", rootHistoryEntries: 2, documents: [] }],
  }), /root session history/);
});

test("the reclaim close reads the processes that remain and awaits only the exit of the processes that host.window reports ending", { timeout: 5000 }, async () => {
  const calls = [];
  let clock = 1_000_000_000;
  const before = { documents: [{ surface: "view-1", document: "", process: 4101 }, { surface: "view-1", document: "doc-1", process: 4102 },
    { surface: "view-1", document: "doc-2", process: 4103 }, { surface: "view-1", document: "doc-3", process: 4104 }] };
  // After the close, host.window first still lists the closed view. Then 4101 is ending, 4102 holds a page of another surface,
  // 4103 remains without a page and 4104 has exited.
  const after = [before, { documents: [{ surface: "other", document: "", process: 4102 }],
    pagelessProcesses: [{ pid: 4101, ending: true }, { pid: 4103, ending: false }] }];
  const s = {
    async get(name) { assert.equal(name, "host.window"); return before; },
    async request(method, params) {
      calls.push(method === "diagnostics.process.exit" ? `exit ${params.pid}` : method);
      if (method === "diagnostics.clock") { clock += 1_000_000; return { mono_ns: String(clock) }; }
      assert.equal(method, "diagnostics.process.exit");
      return null;
    },
    async run(method) { calls.push(method); return { closed: true }; },
    async until(name, predicate) {
      if (name === "core.surfaces") { assert.ok(predicate([])); return []; }
      assert.equal(name, "host.window");
      const value = after.find((candidate) => predicate(candidate));
      calls.push("host.window without the closed views");
      return value;
    },
  };
  const beforeProcesses = [4101, 4102, 4103, 4104].map((pid) => ({ pid, footprintBytes: 1_000_000 }));
  const closedViews = [{ surface: "view-1", rootHistoryEntries: 1, documents: ["doc-1", "doc-2", "doc-3"]
    .map((document) => ({ document, historyEntries: 1 })) }];
  const measured = [];
  const result = await closeViewGroup({ diagnostic() {} }, s, { placement: TAB_PLACEMENT, surfaces: ["view-1"], beforeProcesses,
    closedViews, measureFootprint: (pid) => { measured.push(pid); return 3_000_000; } });
  assert.deepEqual(result.afterProcesses, [{ pid: 4101, footprintBytes: 0 },
    { pid: 4102, footprintBytes: 3_000_000, remained: "page" }, { pid: 4103, footprintBytes: 3_000_000, remained: "no page" },
    { pid: 4104, footprintBytes: 0 }]);
  assert.equal(result.engineCacheHeld, true);
  assert.deepEqual(measured.sort(), [4102, 4103], "the processes that remained were not read at the time of the measurement");
  assert.deepEqual(calls.filter((call) => call.startsWith("exit ")), ["exit 4101"],
    "the close awaited the exit of a process that host.window did not report ending");
  assert.ok(calls.indexOf("core.tab.close") < calls.indexOf("host.window without the closed views")
    && calls.indexOf("host.window without the closed views") < calls.indexOf("exit 4101"),
    `the exit wait did not follow the close and its host.window reading: ${calls}`);
});

test("the reclaim close refuses a host.window that does not report the processes without a page", { timeout: 5000 }, async () => {
  const s = {
    async get() { return { documents: [{ surface: "view-1", document: "", process: 4101 }] }; },
    async request() { return { mono_ns: "1000000000" }; },
    async run() { return { closed: true }; },
    async until(name, predicate) {
      const value = name === "host.window" ? { documents: [], pagelessProcesses: null } : [];
      assert.ok(predicate(value));
      return value;
    },
  };
  await assert.rejects(closeViewGroup({ diagnostic() {} }, s, { placement: TAB_PLACEMENT, surfaces: ["view-1"],
    beforeProcesses: [{ pid: 4101, footprintBytes: 1 }], closedViews: [{ surface: "view-1", rootHistoryEntries: 1, documents: [] }] }),
  /does not report the processes without a page/);
});

test("the end of a reclaim exit wait fails the close with its reason", { timeout: 5000 }, async () => {
  const s = {
    async get() { return { documents: [{ surface: "view-1", document: "", process: 4101 }] }; },
    async request(method) {
      if (method === "diagnostics.clock") return { mono_ns: "1000000000" };
      throw new Error("process 4101 did not exit before the endpoint connection of the request closed");
    },
    async run() { return { closed: true }; },
    async until(name, predicate) {
      const value = name === "host.window" ? { documents: [], pagelessProcesses: [{ pid: 4101, ending: true }] } : [];
      assert.ok(predicate(value));
      return value;
    },
  };
  await assert.rejects(closeViewGroup({ diagnostic() {} }, s, { placement: TAB_PLACEMENT, surfaces: ["view-1"],
    beforeProcesses: [{ pid: 4101, footprintBytes: 1 }], closedViews: [{ surface: "view-1", rootHistoryEntries: 1, documents: [] }],
    measureFootprint: () => assert.fail("an ended exit wait read a footprint") }),
  { message: "process 4101 did not exit before the endpoint connection of the request closed" });
});

test("a view descriptor without a placement is refused by every collector with an error that names the descriptor", { timeout: 5000 }, async (t) => {
  const descriptor = { plugin: "fixture", readinessStatus: "fixture.ready", readiness: async () => {}, expectedContent: "fixture",
    language: "en-US" };
  const refused = { message: "view descriptor fixture has no placement with the functions card, open and close" };
  const untouched = new Proxy({}, { get(_, name) { throw new Error(`the session was used for ${String(name)}`); } });
  await assert.rejects(openRecordedView(t, untouched, { card: "card-1", ...descriptor }), refused);
  await assert.rejects(collectViewStartAndMemory(t, untouched, descriptor), refused);
  await assert.rejects(collectViewReclaimMeasurements(t, untouched, descriptor, [{ surface: "view-1" }]), refused);
  await assert.rejects(openRecordedView(t, untouched, { card: "card-1", ...descriptor, placement: { card() {}, open() {} } }), refused);
  await assert.rejects(closeViewGroup(t, untouched, { surfaces: ["view-1"], beforeProcesses: [{ pid: 1, footprintBytes: 1 }],
    closedViews: [{ surface: "view-1", rootHistoryEntries: 1, documents: [] }] }),
  { message: "view close has no placement with the functions card, open and close" });
});

test("the tab placement chooses a card with a tab of another plugin, adds the view as a tab and closes it as a tab", { timeout: 5000 }, async () => {
  const grid = { cards: [{ id: "card-1", tabs: [{ id: "other", plugin: "other-fixture" }] }] };
  assert.equal(TAB_PLACEMENT.card(grid, "fixture", "card-1"), viewCardWithDifferentPluginTab(grid, "fixture", "card-1"));
  const calls = [];
  let registered = true;
  const s = {
    async run(method, params) {
      calls.push([method, params]);
      if (method === "core.card.add-tab") return { tab: "view-1" };
      registered = false;
      return { closed: true };
    },
    async until(name, predicate, message) {
      calls.push([name, message]);
      const surfaces = registered ? [{ surface: "view-1" }] : [];
      assert.ok(predicate(surfaces), message);
      return surfaces;
    },
  };
  assert.equal(await TAB_PLACEMENT.open(s, { card: "card-1", plugin: "fixture", params: { path: "a.txt" } }), "view-1");
  await TAB_PLACEMENT.close(s, "view-1", { cleanup: false });
  assert.deepEqual(calls, [
    ["core.card.add-tab", { card: "card-1", plugin: "fixture", params: { path: "a.txt" } }],
    ["core.tab.close", { tab: "view-1" }],
    ["core.surfaces", "view view-1 remained registered after close"],
  ]);
  s.run = async () => ({ closed: false });
  await assert.rejects(TAB_PLACEMENT.close(s, "view-1", { cleanup: true }), { message: /^view view-1 did not close during cleanup\n/ });
  assert.ok(Object.isFrozen(TAB_PLACEMENT));
});

function dragTraceModeSession(t, { performanceTrace, logPolicy }) {
  const configDir = mkdtempSync(join(tmpdir(), "drag-trace-mode-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const values = { "diagnostics.performance": performanceTrace, "diagnostics.log": structuredClone(logPolicy) };
  const writePolicy = () => writeFileSync(join(configDir, "log-policy.json"), JSON.stringify(policyOfSetting(values["diagnostics.log"])));
  writePolicy();
  const calls = [];
  return {
    calls,
    values,
    session: {
      app: { configDir },
      // The connection of the fixture stays open, so the policy wait ends only by the policy file.
      client: { ended: new Promise(() => {}) },
      async get(name) {
        assert.equal(name, "core.settings");
        return { values: structuredClone(values) };
      },
      async run(name, params) {
        calls.push({ name, params });
        assert.equal(name, "core.settings.set");
        assert.equal(params.scope, "common");
        Object.assign(values, structuredClone(params.patch));
        writePolicy();
        return null;
      },
    },
  };
}

test("a measured drag stores only the frame class without the performance trace and restores both settings", { timeout: 5000 }, async (t) => {
  const logPolicy = { frame: "trace", call: "debug" };
  const { session, calls, values } = dragTraceModeSession(t, { performanceTrace: true, logPolicy });
  const result = await withDragTraceMode(session, async () => {
    const during = (await session.get("core.settings")).values;
    assert.equal(during["diagnostics.performance"], false);
    assert.deepEqual(during["diagnostics.log"], { frame: "trace" });
    assert.deepEqual(readPolicy(session.app.configDir).classes, policyOfSetting({ frame: "trace" }).classes);
    return { gesture: "captured" };
  });
  assert.deepEqual(result, {
    result: { gesture: "captured" },
    phaseMode: {
      performanceTrace: { before: true, during: false, after: true },
      logPolicy: { before: logPolicy, during: { frame: "trace" }, after: logPolicy },
    },
  });
  assert.deepEqual(calls.map(({ params }) => params.patch), [
    { "diagnostics.performance": false, "diagnostics.log": { frame: "trace" } },
    { "diagnostics.performance": true, "diagnostics.log": logPolicy },
  ]);
  assert.equal(values["diagnostics.performance"], true);
  assert.deepEqual(readPolicy(session.app.configDir).classes, policyOfSetting(logPolicy).classes);
});

test("a measured drag keeps the failure of its action and of the restoration", { timeout: 5000 }, async (t) => {
  const { session, values } = dragTraceModeSession(t, { performanceTrace: true, logPolicy: { frame: "trace" } });
  const restoreError = new Error("trace setting restoration failed");
  const actionError = new Error("drag evidence failed");
  const originalRun = session.run;
  session.run = async (name, params) => {
    if (params.patch["diagnostics.performance"] === true) {
      values["diagnostics.performance"] = true;
      throw restoreError;
    }
    return originalRun(name, params);
  };
  await assert.rejects(withDragTraceMode(session, async () => { throw actionError; }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [actionError, restoreError]);
    return true;
  });
  assert.equal(values["diagnostics.performance"], true);
});

test("a measured drag restores the settings when the settings cannot be read after it", { timeout: 5000 }, async (t) => {
  const logPolicy = { frame: "trace", call: "debug" };
  const { session, values } = dragTraceModeSession(t, { performanceTrace: true, logPolicy });
  const stateError = new Error("post-action settings read failed");
  const originalGet = session.get;
  let reads = 0;
  session.get = async (name) => {
    reads++;
    if (reads === 3) throw stateError;
    return originalGet(name);
  };
  await assert.rejects(withDragTraceMode(session, async () => "captured"), (error) => error === stateError);
  assert.equal(values["diagnostics.performance"], true);
  assert.deepEqual(values["diagnostics.log"], logPolicy);
});

test("a measured drag refuses a log policy without the frame trace and changes nothing", { timeout: 5000 }, async (t) => {
  const { session, calls } = dragTraceModeSession(t, { performanceTrace: true, logPolicy: {} });
  await assert.rejects(withDragTraceMode(session, async () => "captured"), /drag requires the frame trace log policy/);
  assert.deepEqual(calls, []);
});

test("a measured drag keeps a falsy rejection of its action", { timeout: 5000 }, async (t) => {
  for (const failure of [null, undefined, 0]) {
    const { session, values } = dragTraceModeSession(t, { performanceTrace: true, logPolicy: { frame: "trace" } });
    await assert.rejects(withDragTraceMode(session, async () => { throw failure; }), (error) => error === failure);
    assert.equal(values["diagnostics.performance"], true);
  }
});

test("reclaim finishes the content verification of the same live recorded view before its footprint/close interval begins", { timeout: 5000 }, async () => {
  const calls = ["normal recording stopped"];
  let alive = true;
  let verified = false;
  const view = { surface: "recorded-original", async verifyContent() {
    assert.equal(alive, true, "an ended view cannot have its content verified");
    calls.push("verification started");
    await Promise.resolve();
    verified = true;
    calls.push("verification finished");
    return { contentFrame: { frameIndex: 2, timeMs: 3, proof: { method: "value", expected: "x", actual: "x" } } };
  } };
  assert.equal(typeof viewMetrics.closeVerifiedRecordedViewGroup, "function", "reclaim must own verification before it closes the target");
  const result = await viewMetrics.closeVerifiedRecordedViewGroup([view], async () => {
    assert.equal(verified, true);
    assert.equal(alive, true);
    calls.push("before footprint");
    alive = false;
    calls.push("original target closed", "after footprint");
    return { exactSample: true };
  });
  assert.deepEqual(result, { exactSample: true });
  assert.deepEqual(calls, ["normal recording stopped", "verification started", "verification finished",
    "before footprint", "original target closed", "after footprint"]);
  assert.equal(view.surface, "recorded-original");
});

test("reclaim preserves a failed content verification without closing or substituting a target", { timeout: 5000 }, async () => {
  const failure = new Error("original content verification failed");
  let closed = false;
  assert.equal(typeof viewMetrics.closeVerifiedRecordedViewGroup, "function", "reclaim admission must precede close");
  await assert.rejects(viewMetrics.closeVerifiedRecordedViewGroup([{ surface: "original", verifyContent: async () => { throw failure; } }],
    async () => { closed = true; }), error => error === failure);
  assert.equal(closed, false);
});

test("actual reclaim collector verifies content before the existing measured close group", { timeout: 5000 }, async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../view-metrics-collection.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export async function collectViewReclaimMeasurements("), source.indexOf("/** Executes process, memory"));
  assert.ok(body.includes("closeVerifiedRecordedViewGroup(views,"), "actual initial and reopened reclaim groups must verify content before the measured close");
  assert.equal(body.includes("const sample = await closeInitial([view]);\n    await verifyOpenedViewContent(view);"), false,
    "live verification after the measured close is forbidden");
});

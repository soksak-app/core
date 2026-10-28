import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findFirstChangedSlotFrame } from "../view-frame-geometry.mjs";
import * as terminalCase from "../benchmark/cases/terminal.mjs";
import { terminalDragGeometryFrame, terminalFirstContentFrame, terminalSourceContentFrame,
  terminalViewDescriptor, writeTerminalDragLayouts, measureTerminalLayoutFrame,
  setTerminalGeometryBackground, terminalRasterTargetRectPt, TERMINAL_GEOMETRY_BACKGROUND }
  from "../benchmark/cases/terminal.mjs";

function terminalTraceModeSession({ performanceTrace, logPolicy }) {
  const values = {
    "diagnostics.performance": performanceTrace,
    "diagnostics.log": structuredClone(logPolicy),
  };
  const calls = [];
  return {
    calls,
    values,
    session: {
      async get(name) {
        assert.equal(name, "core.settings");
        return { values: structuredClone(values) };
      },
      async run(name, params) {
        calls.push({ name, params });
        assert.equal(name, "core.settings.change");
        assert.equal(params.key, "diagnostics.performance");
        assert.equal(params.scope, "common");
        values["diagnostics.performance"] = params.value;
        return null;
      },
    },
  };
}

test("terminal drag performance trace mode preserves frame logging and restores the original setting", { timeout: 5000 }, async () => {
  const runInMode = terminalCase.withTerminalDragTraceMode;
  assert.equal(typeof runInMode, "function", "terminal drag must expose its production trace-mode boundary");
  const logPolicy = { frame: "trace", call: "debug" };
  const { session, calls, values } = terminalTraceModeSession({ performanceTrace: true, logPolicy });
  const result = await runInMode(session, async () => {
    const during = (await session.get("core.settings")).values;
    assert.equal(during["diagnostics.performance"], false);
    assert.deepEqual(during["diagnostics.log"], logPolicy);
    return { gesture: "captured" };
  });
  assert.deepEqual(result, {
    result: { gesture: "captured" },
    phaseMode: {
      performanceTrace: { before: true, during: false, after: true },
      logPolicy: { before: logPolicy, during: logPolicy, after: logPolicy },
    },
  });
  assert.deepEqual(calls, [
    { name: "core.settings.change", params: { key: "diagnostics.performance", value: false, scope: "common" } },
    { name: "core.settings.change", params: { key: "diagnostics.performance", value: true, scope: "common" } },
  ]);
  assert.equal(values["diagnostics.performance"], true);
  assert.deepEqual(values["diagnostics.log"], logPolicy);
});

test("terminal drag trace-mode cleanup preserves action and after-write restoration failures", { timeout: 5000 }, async () => {
  const runInMode = terminalCase.withTerminalDragTraceMode;
  assert.equal(typeof runInMode, "function", "terminal drag must expose its production trace-mode boundary");
  const logPolicy = { frame: "trace" };
  const { session, calls, values } = terminalTraceModeSession({ performanceTrace: true, logPolicy });
  const restoreError = new Error("trace setting restoration failed");
  const actionError = new Error("drag evidence failed");
  const originalRun = session.run;
  session.run = async (name, params) => {
    if (params.value === true) {
      calls.push({ name, params });
      values["diagnostics.performance"] = true;
      throw restoreError;
    }
    return originalRun(name, params);
  };
  await assert.rejects(runInMode(session, async () => { throw actionError; }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [actionError, restoreError]);
    return true;
  });
  assert.deepEqual(calls.map(({ params }) => params.value), [false, true]);
  assert.equal(values["diagnostics.performance"], true);
  assert.deepEqual(values["diagnostics.log"], logPolicy);
});

test("terminal drag trace mode restores performance even when post-action settings cannot be read", { timeout: 5000 }, async () => {
  const runInMode = terminalCase.withTerminalDragTraceMode;
  assert.equal(typeof runInMode, "function", "terminal drag must expose its production trace-mode boundary");
  const { session, calls, values } = terminalTraceModeSession({ performanceTrace: true, logPolicy: { frame: "trace" } });
  const stateError = new Error("post-action settings read failed");
  const originalGet = session.get;
  let reads = 0;
  session.get = async (name) => {
    reads++;
    if (reads === 3) throw stateError;
    return originalGet(name);
  };
  await assert.rejects(runInMode(session, async () => "captured"), (error) => error === stateError);
  assert.deepEqual(calls.map(({ params }) => params.value), [false, true]);
  assert.equal(values["diagnostics.performance"], true);
});

test("terminal drag trace mode restores performance before reporting a changed log policy", { timeout: 5000 }, async () => {
  const runInMode = terminalCase.withTerminalDragTraceMode;
  assert.equal(typeof runInMode, "function", "terminal drag must expose its production trace-mode boundary");
  const { session, calls, values } = terminalTraceModeSession({ performanceTrace: true, logPolicy: { frame: "trace" } });
  await assert.rejects(runInMode(session, async () => {
    values["diagnostics.log"] = {};
    return "captured";
  }), /terminal drag requires the frame trace log policy/);
  assert.deepEqual(calls.map(({ params }) => params.value), [false, true]);
  assert.equal(values["diagnostics.performance"], true);
});

test("terminal drag trace mode preserves falsy action rejection values", { timeout: 5000 }, async () => {
  for (const failure of [null, undefined, 0]) {
    const { session, values } = terminalTraceModeSession({ performanceTrace: true, logPolicy: { frame: "trace" } });
    await assert.rejects(runTerminalTraceMode(session, async () => { throw failure; }),
      (error) => error === failure);
    assert.equal(values["diagnostics.performance"], true);
  }
});

async function runTerminalTraceMode(session, action) {
  const runInMode = terminalCase.withTerminalDragTraceMode;
  assert.equal(typeof runInMode, "function", "terminal drag must expose its production trace-mode boundary");
  return runInMode(session, action);
}

function terminalLayoutFrame({ cardLeft, rootLeft, time, contentColor = TERMINAL_GEOMETRY_BACKGROUND }) {
  const width = 1024;
  const height = 768;
  const stride = width * 4;
  const data = Buffer.alloc(stride * height);
  const plane = [16, 17, 23];
  const cardColor = [25, 27, 36];
  const edgeColor = [43, 46, 61];
  const focusCornerBlend = [32, 28, 29];
  const paint = (x, y, [red, green, blue]) => {
    const offset = y * stride + x * 4;
    data[offset] = blue;
    data[offset + 1] = green;
    data[offset + 2] = red;
    data[offset + 3] = 255;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) paint(x, y, plane);
  const card = { left: cardLeft, top: 16, right: 950, bottom: 647 };
  for (let y = card.top; y < card.bottom; y++) for (let x = card.left; x < card.right; x++) {
    const edge = x < card.left + 2 || x >= card.right - 2 || y < card.top + 2 || y >= card.bottom - 2;
    paint(x, y, edge ? edgeColor : cardColor);
  }
  const content = { left: rootLeft, top: 82, right: 948, bottom: 601 };
  for (let y = content.top; y < content.bottom; y++) {
    for (let x = content.left; x < content.right; x++) paint(x, y, contentColor);
  }
  for (const x of [card.left + 9, card.right - 10]) {
    for (const y of [card.top + 2, card.bottom - 3]) paint(x, y, focusCornerBlend);
  }
  return { width, height, stride, scale: 2, contentScale: 1, content: { x: 0, y: 0 }, time, data };
}

test("terminal layout geometry excludes captured focus-corner colors from content bounds", { timeout: 5000 }, () => {
  const before = measureTerminalLayoutFrame(terminalLayoutFrame({ cardLeft: 200, rootLeft: 202, time: 10 }), {
    cornerRadiusPt: 8, targetRect: { x: 101, y: 41, width: 373, height: 259.5 },
  });
  const after = measureTerminalLayoutFrame(terminalLayoutFrame({ cardLeft: 40, rootLeft: 42, time: 20 }), {
    cornerRadiusPt: 8, targetRect: { x: 21, y: 41, width: 453, height: 259.5 },
  });
  let slotError = null;
  let slotMatch;
  try {
    slotMatch = findFirstChangedSlotFrame([before, after], { beforeChangeTimeMs: 15,
      slotInsetsPt: { left: 1, top: 33, right: 1, bottom: 23 } });
  } catch (error) {
    slotError = error.message;
  }
  assert.deepEqual({ before: before.nativeRectPt, after: after.nativeRectPt, slotError, slotMatch }, {
    before: { left: 101, top: 41, right: 474, bottom: 300.5 },
    after: { left: 21, top: 41, right: 474, bottom: 300.5 },
    slotError: null,
    slotMatch: {
      baselineFrameIndex: 0, changeFrameIndex: 1, contentFrameIndex: 1,
      slotMatchFrameIndices: [1], maxSlotErrorPt: 0,
    },
  });
});

test("terminal geometry background uses one distinctive OSC 11 color and waits for its output", { timeout: 5000 }, async () => {
  const surface = "surface-a";
  const marker = `TERMINAL-GEOMETRY-${surface}`;
  const calls = [];
  const session = {
    async run(name, params, selectedSurface) {
      calls.push({ name, params, surface: selectedSurface });
    },
    async until(name, predicate, message, options) {
      calls.push({ name, message, options });
      const lines = [[{ ch: marker, width: marker.length }]];
      assert.equal(predicate(lines), true);
      return lines;
    },
  };
  await setTerminalGeometryBackground(session, surface);
  const hex = TERMINAL_GEOMETRY_BACKGROUND.map((value) => value.toString(16).padStart(2, "0")).join("/");
  assert.deepEqual(calls, [
    { name: "terminal.input", params: { bytes: `printf '\\033]11;rgb:${hex}\\007${marker}\\n'\r` }, surface },
    { name: "terminal.screen.read", params: {}, surface },
    { name: "terminal.screen", message: `${surface} did not finish the terminal geometry background change`,
      options: { surface } },
  ]);
});

test("terminal drag layout evidence is written before frame analysis", { timeout: 5000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "terminal-drag-layouts-"));
  try {
    const layouts = [{ ticket: 4, begun: 10, presented: 26, committed: 30 }];
    const path = writeTerminalDragLayouts(directory, layouts);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { layouts });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal drag geometry keeps four measured card and raster edges from the same captured frame", { timeout: 5000 }, () => {
  assert.deepEqual(terminalDragGeometryFrame(7, {
    timeMs: 148,
    cardRectPt: { left: 10, top: 20, right: 209.5, bottom: 180 },
    nativeRectPt: { left: 11, top: 21, right: 208.5, bottom: 179 },
  }, { left: 1, top: 1, right: 1, bottom: 1 }), {
    frameIndex: 7,
    timeMs: 148,
    cardRectPt: { left: 10, top: 20, right: 209.5, bottom: 180 },
    nativeRectPt: { left: 11, top: 21, right: 208.5, bottom: 179 },
    contentRectPt: { left: 11, top: 21, right: 208.5, bottom: 179 },
    slotInsetsPt: { left: 1, top: 1, right: 1, bottom: 1 },
    contentInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 },
  });
});

test("terminal source content mapping retains source interval and capture time without placement association", { timeout: 5000 }, () => {
  const source = { sequence: 4, frameIndex: 7, timeRange: { lowerMs: 147, upperMs: 149 }, width: 198, height: 120,
    firstResizeAtMs: 31, resizeAtMs: 31, resizeCount: 1, frameTimeMs: 33,
    source: { documentTimeOriginMs: 1000, eventTsUs: 1_200_000, eventMonoNs: 148_000_000 } };
  assert.deepEqual(terminalSourceContentFrame(source, { time: 150 }), {
    sourceSequence: 4, frameIndex: 7, frameTimeMs: 33, captureTimeMs: 150,
    displayCapture: null, timeRange: { lowerMs: 147, upperMs: 149 }, width: 198, height: 120,
    source: { sequence: 4, firstResizeAtMs: 31, resizeAtMs: 31, resizeCount: 1, frameTimeMs: 33, documentTimeOriginMs: 1000,
      eventTsUs: 1_200_000, eventMonoNs: 148_000_000 },
    displayTimeMs: 150,
  });
  assert.deepEqual(terminalSourceContentFrame({ ...source, frameIndex: null }, null), {
    sourceSequence: 4, frameIndex: null, frameTimeMs: 33, captureTimeMs: null,
    displayCapture: null, timeRange: { lowerMs: 147, upperMs: 149 }, width: 198, height: 120,
    source: { sequence: 4, firstResizeAtMs: 31, resizeAtMs: 31, resizeCount: 1, frameTimeMs: 33, documentTimeOriginMs: 1000,
      eventTsUs: 1_200_000, eventMonoNs: 148_000_000 },
    displayTimeMs: null,
  });
});

test("terminal view descriptor reads browser history and controls only the diagnostic frame observer", { timeout: 5000 }, async () => {
  assert.equal(terminalViewDescriptor.readinessStatus, "terminal.session");
  const calls = [];
  const session = {
    async run(name, params, surface) {
      calls.push({ name, params, surface });
      if (name === "terminal.view.history") return { length: 1 };
      if (name === "terminal.view.frames") return params.action === "start"
        ? { enabled: true, sourceClock: { documentTimeOriginMs: 1000, sourceNowMs: 20, sourceResolutionMs: 1 } }
        : { enabled: false };
      throw new Error(`unexpected command ${name}`);
    },
  };
  assert.deepEqual(await terminalViewDescriptor.readDocument(session, "surface-a"), {
    historyEntries: 1, regionHistoryEntries: 0,
  });
  assert.deepEqual(await terminalViewDescriptor.startContentTrace(session, "surface-a"), {
    enabled: true, sourceClock: { documentTimeOriginMs: 1000, sourceNowMs: 20, sourceResolutionMs: 1 },
  });
  assert.deepEqual(await terminalViewDescriptor.stopContentTrace(session, "surface-a"), { enabled: false });
  assert.deepEqual(calls, [
    { name: "terminal.view.history", params: {}, surface: "surface-a" },
    { name: "terminal.view.frames", params: { action: "start" }, surface: "surface-a" },
    { name: "terminal.view.frames", params: { action: "stop" }, surface: "surface-a" },
  ]);
});

test("terminal convergence target comes from the visible native raster region", { timeout: 1000 }, () => {
  const host = { regions: [
    { surface: "surface-a", name: "view", visible: true,
      frame: { x: 8, y: 12, width: 700, height: 420 } },
    { surface: "surface-a", name: "toolbar", visible: true,
      frame: { x: 0, y: 0, width: 700, height: 30 } },
  ] };
  assert.deepEqual(terminalRasterTargetRectPt(host, "surface-a"), {
    left: 8, top: 12, right: 708, bottom: 432,
  });
  assert.throws(() => terminalRasterTargetRectPt({ regions: [] }, "surface-a"), /exactly one native raster region/);
});

test("terminal first-content evidence requires the fixed initial shell prompt in captured pixels", { timeout: 5000 }, async () => {
  const result = await terminalFirstContentFrame({
    captured: [{ time: 10 }, { time: 20 }],
    rect: { x: 1, y: 2, w: 30, h: 10 },
    directory: "/tmp/terminal-capture",
    recognizeFrame: async (_frame, rect, language) => {
      assert.deepEqual(rect, { x: 1, y: 2, w: 30, h: 10 });
      assert.equal(language, "en-US");
      return { lines: [language === "en-US" ? "sh-3.2$" : "wrong language"] };
    },
  });
  assert.deepEqual(result, {
    frameIndex: 0,
    frameCount: 2,
    timeMs: 10,
    proof: { expected: "sh-3.2$", actual: "sh-3.2$", lines: ["sh-3.2$"] },
  });
});

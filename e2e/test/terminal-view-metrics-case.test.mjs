import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findFirstChangedSlotFrame } from "../view-frame-geometry.mjs";
import { terminalDragGeometryFrame, terminalFirstContentFrame, terminalSourceContentFrame,
  terminalViewDescriptor, writeTerminalDragLayouts, measureTerminalLayoutFrame,
  setTerminalGeometryBackground, TERMINAL_GEOMETRY_BACKGROUND }
  from "../benchmark/cases/terminal.mjs";

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
    slotInsetsPt: { left: 1, top: 1, right: 1, bottom: 1 },
  });
});

test("terminal source content mapping retains actual placement and projected viewport evidence", { timeout: 5000 }, () => {
  const source = { sequence: 4, timeMs: 148, width: 198, height: 120,
    firstResizeAtMs: 31, resizeAtMs: 31, resizeCount: 1, frameTimeMs: 33,
    source: { documentTimeOriginMs: 1000, ts_us: 1_200_000, mono_ns: 148_000_000 } };
  const nativePlacement = { surface: "terminal-1", phase: "placed", visible: true, timeMs: 147,
    framePt: { x: 10.5, y: 20, width: 198.5, height: 120.5 }, webKitViewport: { width: 198, height: 120 } };
  assert.deepEqual(terminalSourceContentFrame(source, 7, { time: 150 }, nativePlacement), {
    sourceSequence: 4, frameIndex: 7, timeMs: 148, width: 198, height: 120, nativePlacement,
    source: { sequence: 4, firstResizeAtMs: 31, resizeAtMs: 31, resizeCount: 1, frameTimeMs: 33, documentTimeOriginMs: 1000,
      ts_us: 1_200_000, mono_ns: 148_000_000 },
    displayTimeMs: 150,
  });
});

test("terminal view descriptor reads browser history and controls only the diagnostic frame observer", { timeout: 5000 }, async () => {
  assert.equal(terminalViewDescriptor.readinessStatus, "terminal.session");
  const calls = [];
  const session = {
    async run(name, params, surface) {
      calls.push({ name, params, surface });
      if (name === "terminal.view.history") return { length: 1 };
      if (name === "terminal.view.frames") return { enabled: params.action === "start" };
      throw new Error(`unexpected command ${name}`);
    },
  };
  assert.deepEqual(await terminalViewDescriptor.readDocument(session, "surface-a"), {
    historyEntries: 1, regionHistoryEntries: 0,
  });
  assert.deepEqual(await terminalViewDescriptor.startContentTrace(session, "surface-a"), { enabled: true });
  assert.deepEqual(await terminalViewDescriptor.stopContentTrace(session, "surface-a"), { enabled: false });
  assert.deepEqual(calls, [
    { name: "terminal.view.history", params: {}, surface: "surface-a" },
    { name: "terminal.view.frames", params: { action: "start" }, surface: "surface-a" },
    { name: "terminal.view.frames", params: { action: "stop" }, surface: "surface-a" },
  ]);
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

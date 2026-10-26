import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { terminalDragGeometryFrame, terminalFirstContentFrame, terminalSourceContentFrame,
  terminalViewDescriptor, writeTerminalDragLayouts }
  from "../benchmark/cases/terminal.mjs";

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
    resizeAtMs: 31, frameTimeMs: 33, documentTimeOriginMs: 1000,
    source: { ts_us: 1_200_000, mono_ns: 148_000_000 } };
  const nativePlacement = { surface: "terminal-1", phase: "placed", visible: true, timeMs: 147,
    framePt: { x: 10.5, y: 20, width: 198.5, height: 120.5 }, webKitViewport: { width: 198, height: 120 } };
  assert.deepEqual(terminalSourceContentFrame(source, 7, { time: 150 }, nativePlacement), {
    sourceSequence: 4, frameIndex: 7, timeMs: 148, width: 198, height: 120, nativePlacement,
    source: { sequence: 4, resizeAtMs: 31, frameTimeMs: 33, documentTimeOriginMs: 1000,
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

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import renderFixture from "./fixtures/screen-render.json" with { type: "json" };
import { visibleInputBeforeCursor, visibleInputFromRows } from "./terminal-ime-document.mjs";
import {
  captureFromCallback,
  attachImeFrameIdentities,
  capturesByInputStage,
  hostClockBoundary,
  evaluateVisualStages,
  indexFrameStatus,
  planVisualStage,
  persistThenRequireVisualProof,
  readImeFrameIdentities,
  readRetainedSources,
  requireImeRenderer,
  startImeCapture,
} from "./ime-visual-capture.mjs";

function testWithTimeout(name, body) {
  test(name, { timeout: 2000 }, body);
}

const semantic = {
  document: "ㅏ",
  compose: { text: "ㅏ", markedRange: { location: 0, length: 1 }, selectedRange: { location: 1, length: 0 } },
  cursor: { row: 0, col: 1, focused: true, preedit: "ㅏ" },
  geometry: { rows: 1, cols: 1, cellWidth: 4, cellHeight: 6, origin: { x: 0, y: 0 } },
};

function sourceRaster() {
  const data = new Uint8Array(4 * 6 * 4).fill(255);
  const set = (x, y, color) => data.set([color[2], color[1], color[0], 255], (y * 4 + x) * 4);
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) set(x, y, [255, 0, 0]);
  for (let x = 0; x < 4; x++) set(x, 5, [255, 0, 0]);
  return data;
}

function capture(data) {
  return { width: 4, height: 6, bytesPerRow: 16, data, format: "BGRA8", alpha: "premultiplied-first",
    colorSpace: "sRGB", scaleFactor: 1, screenRect: { x: 0, y: 0, width: 4, height: 6 },
    contentRect: { x: 0, y: 0, width: 4, height: 6 } };
}

testWithTimeout("IME visual recording requests the declared frame-identity channel", async () => {
  let params;
  const recording = { frames: "fixture-frames", stop: async () => ({}) };
  const started = await startImeCapture({
    async record(options) { params = options; return recording; },
  }, { frame: { generation: 1, raster: 2, sequence: 3 },
    render: { frame: { generation: 1, raster: 2, sequence: 3 }, glyphs: [] } });
  assert.deepEqual(params, { frameIdentity: true });
  assert.equal(started.recording, recording);
});

testWithTimeout("IME capture does not start when renderer metadata is absent", async () => {
  let called = false;
  await assert.rejects(startImeCapture({ async record() { called = true; } }, {
    frame: { generation: 1, raster: 2, sequence: 3 }, render: null,
  }), (error) => error.code === "IME_RENDER_METADATA_UNAVAILABLE" && /SOKSAK_VT_TRACE_DIR/.test(error.message));
  assert.equal(called, false);
});

testWithTimeout("IME capture does not start when renderer metadata is malformed", async () => {
  let called = false;
  await assert.rejects(startImeCapture({ async record() { called = true; } }, {
    frame: { generation: 1, raster: 2, sequence: 3 },
    render: { frame: { generation: 1, raster: 2, sequence: 3 }, glyphs: null },
  }), /no glyph list/);
  assert.equal(called, false);
});

testWithTimeout("IME visual preflight requires renderer metadata from the same cursor frame", () => {
  const frame = { generation: 1, raster: 2, sequence: 3 };
  assert.equal(requireImeRenderer({ frame, render: { frame, glyphs: [] } }).frame, frame);
  assert.throws(() => requireImeRenderer({ frame, render: null }), /SOKSAK_VT_TRACE_DIR/);
  assert.throws(() => requireImeRenderer({ frame, render: { frame: { ...frame, sequence: 4 }, glyphs: [] } }),
    /different cursor frame/);
});

function writeIdentityFixture(directory, rows, overrides = {}) {
  const identityDirectory = join(directory, "frame-identities");
  mkdirSync(identityDirectory, { recursive: true });
  const bytes = sourceRaster();
  const artifact = { generation: "1", raster: "2", sequence: 3, regionToken: "region-1", nonce: "nonce",
    payload: "payload", roi: { x: 0, y: 0, width: 4, height: 6 }, file: "identity-1.bgra",
    width: 4, height: 6, stride: 16, pixelFormat: "BGRA8", alpha: "premultiplied-first",
    colorSpace: "sRGB", byteCount: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
  writeFileSync(join(identityDirectory, artifact.file), bytes);
  writeFileSync(join(identityDirectory, "decoded-frames.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(join(identityDirectory, "manifest.json"), JSON.stringify({ format: 1, pixelFormat: "BGRA8",
    limits: { issuedIdentities: 512, pendingArtifactBytes: 67108864 }, artifactBytes: bytes.length,
    artifacts: [artifact], droppedArtifacts: 0, writeFailures: 0, cleanupFailures: 0, cleanupErrors: [],
    cleanupErrorsOmitted: 0, decodedFramesFile: "decoded-frames.jsonl", decodedFrames: 1,
    decodedRecords: rows.length, decodedWriteFailures: 0, identityFailure: null, ...overrides }));
  return join(identityDirectory, "manifest.json");
}

testWithTimeout("IME visual consumer joins only issued capture identities and retains unknown outcomes", () => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-ime-frame-identity-"));
  try {
    const matched = { frame: 1, displayTime: "1234", region: "region-1",
      roi: { x: 0, y: 0, width: 4, height: 6 }, status: "matched",
      identity: { generation: "1", raster: "2", sequence: 3 }, reason: null };
    const unknown = { frame: 1, displayTime: "1234", region: null, roi: null, status: "unknown",
      identity: null, reason: "unknown-retention" };
    const manifest = writeIdentityFixture(directory, [matched, unknown]);
    const result = readImeFrameIdentities(directory, { frameIdentity: { manifest, status: "complete" } });
    assert.deepEqual(result.byFrame.get(1), [matched, unknown]);
    assert.deepEqual(result.artifacts, ["1/2/3"]);
    const attached = attachImeFrameIdentities([{ callback: { frame: "frame-0001.bgra", displayTime: "1234" } }],
      ["/capture/frame-0001.bgra"], result);
    assert.deepEqual(attached.get("frame-0001.bgra"), [matched, unknown]);
    assert.throws(() => attachImeFrameIdentities([{ callback: { frame: "frame-0001.bgra", displayTime: "1235" } }],
      ["/capture/frame-0001.bgra"], result), /display time differs/);
    assert.throws(() => attachImeFrameIdentities([{ callback: { frame: "frame-0002.bgra", displayTime: "1234" } }],
      ["/capture/frame-0002.bgra"], result), /no identity decoder record/);

    const unissued = { ...matched, identity: { generation: "1", raster: "2", sequence: 4 } };
    writeIdentityFixture(directory, [unissued]);
    assert.throws(() => readImeFrameIdentities(directory, {
      frameIdentity: { manifest, status: "complete" },
    }), /was not issued/);
    writeIdentityFixture(directory, [matched], { droppedArtifacts: 1 });
    assert.throws(() => readImeFrameIdentities(directory, {
      frameIdentity: { manifest, status: "complete" },
    }), /droppedArtifacts is nonzero/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

testWithTimeout("capture callback adapter preserves the declared BGRA frame geometry", () => {
  const decoded = { width: 4, height: 6, stride: 16, scale: 1, data: sourceRaster() };
  const callback = { imageMatch: { captureFrame: { width: 4, height: 6, stride: 16,
    pixelFormat: 0x42475241, colorSpace: "sRGB", scaleFactor: 1,
    screenRect: { x: 0, y: 0, width: 4, height: 6 },
    contentRect: { x: 0, y: 0, width: 4, height: 6 } } } };
  assert.deepEqual(captureFromCallback(decoded, callback), capture(decoded.data));
  assert.throws(() => captureFromCallback(decoded, { imageMatch: { captureFrame: {
    ...callback.imageMatch.captureFrame, pixelFormat: 0,
  } } }), /pixel format/);
});

testWithTimeout("capture frames map to one half-open input interval by exact Mach display time", () => {
  const decoded = { width: 4, height: 6, stride: 16, scale: 1, time: 1000, data: sourceRaster() };
  const callback = { displayTime: "1000000000", machTimebaseNumerator: 1, machTimebaseDenominator: 1,
    imageMatch: { captureFrame: { width: 4, height: 6, stride: 16, pixelFormat: 0x42475241,
      colorSpace: "sRGB", scaleFactor: 1, screenRect: { x: 0, y: 0, width: 4, height: 6 },
      contentRect: { x: 0, y: 0, width: 4, height: 6 } } } };
  const identityRows = [{ status: "matched", identity: { generation: "1", raster: "2", sequence: 3 } }];
  const grouped = capturesByInputStage([{ name: "frame-0001.bgra", callback, identityRows }], [decoded], [
    { key: "first", clockDomain: "mach-absolute", startedMachAbsoluteNs: "900000000",
      endedMachAbsoluteNs: "1000000000" },
    { key: "second", clockDomain: "mach-absolute", startedMachAbsoluteNs: "1000000000",
      endedMachAbsoluteNs: "1100000000" },
  ]);
  assert.equal(grouped.get("first").length, 0);
  assert.equal(grouped.get("second").length, 1);
  assert.equal(grouped.get("second")[0].name, "frame-0001.bgra");
});

testWithTimeout("host clock boundaries use the declared endpoint and canonical Mach-absolute nanoseconds", async () => {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    return { mono_ns: "18446744073709551615" };
  };
  assert.deepEqual(await hostClockBoundary(request), {
    clockDomain: "mach-absolute",
    machAbsoluteNs: "18446744073709551615",
  });
  assert.deepEqual(calls, [{ method: "diagnostics.clock", params: {} }]);
  const invalidReplies = [
    null,
    {},
    { clock: { mono_ns: "1000000123" } },
    { mono_ns: 1000000123 },
    { mono_ns: "0" },
    { mono_ns: "01" },
    { mono_ns: "+1" },
    { mono_ns: "1e3" },
    { mono_ns: "1.0" },
    { mono_ns: "18446744073709551616" },
    { mono_ns: "1000000123", extra: true },
  ];
  for (const reply of invalidReplies) {
    await assert.rejects(hostClockBoundary(async () => reply), /diagnostics\.clock/,
      `invalid diagnostics.clock reply was accepted: ${JSON.stringify(reply)}`);
  }
});

testWithTimeout("capture stage attribution rejects continuous-time boundaries even when values overlap", () => {
  const decoded = { width: 4, height: 6, stride: 16, scale: 1, time: 1000, data: sourceRaster() };
  const callback = { displayTime: "1000000000", machTimebaseNumerator: 1, machTimebaseDenominator: 1,
    imageMatch: { captureFrame: { width: 4, height: 6, stride: 16, pixelFormat: 0x42475241,
      colorSpace: "sRGB", scaleFactor: 1, screenRect: { x: 0, y: 0, width: 4, height: 6 },
      contentRect: { x: 0, y: 0, width: 4, height: 6 } } } };
  assert.throws(() => capturesByInputStage([{ name: "frame-0001.bgra", callback,
    identityRows: [{ status: "matched", identity: { generation: "1", raster: "2", sequence: 3 } }] }], [decoded], [
    { key: "wrong-clock", clockDomain: "mach-continuous", startedMachAbsoluteNs: "900000000",
      endedMachAbsoluteNs: "1100000000" },
  ]), /must use the mach-absolute clock domain/);
});

testWithTimeout("source manifest loads only digest-verified frame-bound rasters", () => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-ime-source-"));
  try {
    mkdirSync(join(directory, "sources"));
    const data = sourceRaster();
    const sha256 = createHash("sha256").update(data).digest("hex");
    const artifact = { generation: "1", raster: "2", sequence: 3, file: "frame-1-2-3.bgra",
      width: 4, height: 6, stride: 16, pixelFormat: "BGRA8", alpha: "premultiplied-first",
      screenBounds: { x: 0, y: 0, width: 4, height: 6 }, scale: 1, colorSpace: "sRGB",
      byteCount: data.length, sha256 };
    writeFileSync(join(directory, "sources", artifact.file), data);
    writeFileSync(join(directory, "sources", "manifest.json"), JSON.stringify({ format: 2,
      pixelFormat: "BGRA8", alpha: "premultiplied-first", droppedSources: 0, writeFailures: 0,
      artifacts: [artifact] }));
    const state = { frame: { generation: 1, raster: 2, sequence: 3 }, render: renderFixture, semantic };
    const loaded = readRetainedSources(directory, new Map([[
      "1/2/3", state,
    ]]));
    assert.equal(loaded.missingStates.length, 0);
    assert.deepEqual(loaded.sources[0].raster.data, data);
    assert.deepEqual(loaded.sources[0].raster.grid, { rows: 1, cols: 1, cellWidth: 4,
      cellHeight: 6, x: 0, y: 0 });
    assert.deepEqual(readRetainedSources(directory, new Map()).missingStates, ["1/2/3"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

testWithTimeout("cursor frame state uses prior screen rows and the exact cursor render identity", () => {
  const frame = renderFixture.frame;
  const cursor = { row: 0, col: 1, focused: true, visible: false, blinkVisible: false,
    shape: "beam", frame, render: renderFixture,
    preedit: { text: "ㅏ", markedRange: { location: 0, length: 1 }, selectedRange: { location: 1, length: 0 },
      replacementRange: null, attributed: true } };
  const events = [
    { name: "terminal.compose", value: { ...cursor.preedit, attributed: true } },
    { name: "terminal.screen", value: [[{ ch: "$", width: 1 }]] },
    { name: "terminal.cursor", value: cursor },
  ];
  const states = indexFrameStatus(events, { row: 0, col: 0, text: "$" });
  assert.equal(states.get("1/2/3").semantic.document, "ㅏ");
  const missingScreen = indexFrameStatus([events[0], events[2]], { row: 0, col: 0, text: "$" });
  assert.equal(missingScreen.size, 0);
  assert.deepEqual(missingScreen.rejections, [{ frame: "1/2/3", eventIndex: 1,
    reason: "prior-screen-status-is-missing" }]);
  assert.equal(indexFrameStatus([events[0], events[1], { ...events[2], value: {
    ...cursor, frame: { ...frame, sequence: frame.sequence + 1 },
  } }], { row: 0, col: 0, text: "$" }).size, 0);
});

testWithTimeout("visual indexing projects rows-only screen status without inventing a screen frame", () => {
  const frame = renderFixture.frame;
  const preedit = { text: "ㅏ", markedRange: { location: 0, length: 1 },
    selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: true };
  const rows = [[{ ch: "$", width: 1 }, { ch: " ", width: 1 }]];
  const cursor = { row: 0, col: 2, focused: true, frame, render: renderFixture, preedit };
  const events = [
    { name: "terminal.screen", value: rows },
    { name: "terminal.compose", value: preedit },
    { name: "terminal.cursor", value: cursor },
  ];
  assert.equal(visibleInputFromRows(rows, cursor, { row: 0, col: 0, text: "$ " }, preedit.text), "ㅏ");
  assert.throws(() => visibleInputBeforeCursor({ rows }, cursor,
    { row: 0, col: 0, text: "$ " }, preedit.text), /terminal\.screen\.read frame is invalid/);
  const states = indexFrameStatus(events, { row: 0, col: 0, text: "$ " });
  assert.equal(states.get("1/2/3")?.semantic.document, "ㅏ");
  assert.deepEqual(states.get("1/2/3")?.rows, rows);
  assert.deepEqual(states.get("1/2/3")?.eventIndexes, { screen: 0, cursor: 2 });
  assert.deepEqual(states.rejections, []);
});

testWithTimeout("indexes an advanced cursor frame against prior rows when identical rows suppress screen status", () => {
  const frame = renderFixture.frame;
  const rows = [[{ ch: "$", width: 1 }, { ch: " ", width: 1 }]];
  const preedit = { text: "ㅏ", markedRange: { location: 0, length: 1 },
    selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: true };
  const cursor = { row: 0, col: 2, focused: true, visible: false, blinkVisible: false,
    shape: "beam", frame, render: renderFixture, preedit };
  const events = [
    { name: "terminal.screen", value: rows },
    { name: "terminal.compose", value: preedit },
    { name: "terminal.cursor", value: cursor },
  ];

  const states = indexFrameStatus(events, { row: 0, col: 0, text: "$ " });
  assert.equal(states.get("1/2/3")?.semantic.document, "ㅏ");
  assert.deepEqual(states.get("1/2/3")?.eventIndexes, { screen: 0, cursor: 2 });
  assert.equal(states.get("1/2/3")?.screenRowsReused, true);
});

testWithTimeout("rejects future rows but reuses identical rows across a frame generation change", () => {
  const frame = renderFixture.frame;
  const rows = [[{ ch: "$", width: 1 }, { ch: " ", width: 1 }]];
  const empty = { text: "", markedRange: null, selectedRange: null,
    replacementRange: null, attributed: false };
  const compose = { text: "ㅏ", markedRange: { location: 0, length: 1 },
    selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: true };
  const cursorFor = (identity, preedit) => ({ row: 0, col: 2, focused: true,
    visible: false, blinkVisible: false, shape: "beam", frame: identity,
    render: { ...renderFixture, frame: identity }, preedit });
  const priorCursor = cursorFor(frame, empty);
  const advanced = { ...frame, generation: frame.generation + 1, sequence: 1 };
  const changedCursor = cursorFor(advanced, compose);
  const prompt = { row: 0, col: 0, text: "$ " };

  const noPriorRows = indexFrameStatus([
    { name: "terminal.compose", value: compose },
    { name: "terminal.cursor", value: changedCursor },
    { name: "terminal.screen", value: rows },
  ], prompt);
  assert.equal(noPriorRows.size, 0, "future screen rows cannot source an earlier cursor event");
  assert.equal(noPriorRows.rejections[0].reason, "prior-screen-status-is-missing");

  const changedGeneration = indexFrameStatus([
    { name: "terminal.screen", value: rows },
    { name: "terminal.compose", value: empty },
    { name: "terminal.cursor", value: priorCursor },
    { name: "terminal.compose", value: compose },
    { name: "terminal.cursor", value: changedCursor },
  ], prompt);
  const advancedKey = `${advanced.generation}/${advanced.raster}/${advanced.sequence}`;
  assert.equal(changedGeneration.get(advancedKey)?.semantic.document, "ㅏ");
  assert.deepEqual(changedGeneration.get(advancedKey)?.eventIndexes, { screen: 0, cursor: 4 });
  assert.equal(changedGeneration.get(advancedKey)?.screenRowsReused, true);

  const regressed = indexFrameStatus([
    { name: "terminal.screen", value: rows },
    { name: "terminal.compose", value: empty },
    { name: "terminal.cursor", value: priorCursor },
    { name: "terminal.cursor", value: cursorFor({ ...frame, sequence: frame.sequence - 1 }, empty) },
  ], prompt);
  assert.equal(regressed.has(`${frame.generation}/${frame.raster}/${frame.sequence - 1}`), false);
  assert.equal(regressed.rejections.at(-1).reason, "cursor-frame-sequence-regressed");
});

testWithTimeout("stage planning covers the complete Hangul span, preedit underline, and one guard cell", () => {
  const frame = { generation: 1, raster: 2, sequence: 3 };
  const glyph = { row: 0, col: 2, width: 2, fontRuns: 1, grapheme: "ㅏ",
    foreground: "#000000", background: "#ffffff", bounds: { x: 0, y: 1, width: 4, height: 3 },
    underline: { rect: { x: 0, y: 5, width: 8, height: 1 } } };
  const render = { ...renderFixture, frame,
    grid: { rows: 1, cols: 6, origin: { x: 0, y: 0 }, cellWidth: 4, cellHeight: 6 },
    glyphs: [glyph] };
  const cursor = { frame, render, row: 0, col: 2, focused: true, shape: "beam", visible: false,
    blinkVisible: false, preedit: { text: "ㅏ", markedRange: { location: 0, length: 1 },
      selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: true } };
  const observation = { screen: { frame, rows: [[{ ch: "$", width: 1 }, { ch: " ", width: 1 },
    { width: 0 }, { width: 0 }, { width: 1 }, { width: 1 }]] },
  cursor, compose: { ...cursor.preedit }, presented: frame };
  const frameStatus = new Map([["1/2/3", { frame, render, rows: observation.screen.rows, semantic: {
    document: "ㅏ", compose: { ...cursor.preedit }, cursor: { row: 0, col: 2, focused: true, preedit: "ㅏ" },
    geometry: { rows: 1, cols: 6, cellWidth: 4, cellHeight: 6, origin: { x: 0, y: 0 } },
  }, eventIndexes: { screen: 0, cursor: 1 }, screenRowsReused: false }]]);
  const stage = planVisualStage({ key: "k-1", expectedDocument: "ㅏ", observation, frameStatus,
    prompt: { row: 0, col: 0, text: "$ " } });
  assert.deepEqual(stage.cells, [
    { row: 0, column: 2 }, { row: 0, column: 3 }, { row: 0, column: 4 },
  ]);
  assert.deepEqual(stage.glyphs, [{ row: 0, col: 2, grapheme: "ㅏ", marked: true }]);
  assert.equal(stage.semantic.document, "ㅏ");
  assert.throws(() => planVisualStage({ key: "k-1", expectedDocument: "ㅏㅏ", observation, frameStatus,
    prompt: { row: 0, col: 0, text: "$ " } }), /terminal document differs/);
});

testWithTimeout("stage planning accepts prior base rows with the exact current overlay frame", () => {
  const baseFrame = { generation: 1, raster: 2, sequence: 9 };
  const overlayFrame = { generation: 1, raster: 2, sequence: 11 };
  const glyph = { row: 0, col: 2, width: 2, fontRuns: 1, grapheme: "ㅏ",
    foreground: "#000000", background: "#ffffff", bounds: { x: 0, y: 1, width: 4, height: 3 },
    underline: { rect: { x: 0, y: 5, width: 8, height: 1 } } };
  const render = { ...renderFixture, frame: overlayFrame,
    grid: { rows: 1, cols: 6, origin: { x: 0, y: 0 }, cellWidth: 4, cellHeight: 6 },
    glyphs: [glyph] };
  const compose = { text: "ㅏ", markedRange: { location: 0, length: 1 },
    selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: true };
  const cursor = { frame: overlayFrame, render, row: 0, col: 2, focused: true, shape: "beam", visible: false,
    blinkVisible: false, preedit: compose };
  const rows = [[{ ch: "$", width: 1 }, { ch: " ", width: 1 }, { width: 0 }, { width: 0 },
    { width: 1 }, { width: 1 }]];
  const observation = { screen: { frame: baseFrame, rows }, compose, cursor, presented: overlayFrame };
  const frameStatus = new Map([["1/2/11", { frame: overlayFrame, render, rows,
      semantic: { document: "ㅏ", compose,
        cursor: { row: 0, col: 2, focused: true, preedit: "ㅏ" },
        geometry: { rows: 1, cols: 6, cellWidth: 4, cellHeight: 6, origin: { x: 0, y: 0 } } },
      eventIndexes: { screen: 0, cursor: 2 }, screenRowsReused: true }]]);

  assert.doesNotThrow(() => planVisualStage({ key: "k-1", expectedDocument: "ㅏ", observation, frameStatus,
    prompt: { row: 0, col: 0, text: "$ " } }));
  assert.throws(() => planVisualStage({ key: "k-1", expectedDocument: "ㅏ", observation: {
    ...observation, screen: { ...observation.screen, frame: { ...baseFrame, sequence: 12 } },
  }, frameStatus, prompt: { row: 0, col: 0, text: "$ " } }), /base screen frame sequence is newer/);
  const newerWatermark = { ...observation, presented: { ...overlayFrame, sequence: 12 } };
  assert.doesNotThrow(() => planVisualStage({ key: "k-1", expectedDocument: "ㅏ", observation: newerWatermark,
    frameStatus, prompt: { row: 0, col: 0, text: "$ " } }));
  assert.throws(() => planVisualStage({ key: "k-1", expectedDocument: "ㅏ", observation: {
    ...observation, presented: { ...overlayFrame, sequence: 10 },
  }, frameStatus, prompt: { row: 0, col: 0, text: "$ " } }), /has not reached the cursor frame/);
  assert.throws(() => planVisualStage({ key: "k-1", expectedDocument: "ㅏ", observation: {
    ...observation, presented: { ...overlayFrame, generation: overlayFrame.generation + 1 },
  }, frameStatus, prompt: { row: 0, col: 0, text: "$ " } }), /presentation watermark generation differs/);
  assert.throws(() => planVisualStage({ key: "k-1", expectedDocument: "ㅏ", observation: {
    ...observation, screen: { ...observation.screen, rows: [[{ ch: "$", width: 1 }, { ch: " ", width: 1 }]] },
  }, frameStatus, prompt: { row: 0, col: 0, text: "$ " } }), /differ from the active observer/);
  assert.throws(() => planVisualStage({ key: "k-1", expectedDocument: "ㅏ", observation,
    frameStatus: new Map(), prompt: { row: 0, col: 0, text: "$ " } }), /indexed prior screen rows/);
});

testWithTimeout("visual stage evaluator retains exact target identity and measures each expected glyph", () => {
  const frame = renderFixture.frame;
  const data = sourceRaster();
  const render = { ...renderFixture, cursor: { ...renderFixture.cursor,
    focused: true, visible: false, blinkVisible: false } };
  const source = { frame, render, state: { frame, semantic }, raster: {
    width: 4, height: 6, bytesPerRow: 16, data, format: "BGRA8", alpha: "premultiplied-first",
    colorSpace: "sRGB", scale: 1, screenBounds: { x: 0, y: 0, width: 4, height: 6 },
    grid: { rows: 1, cols: 1, cellWidth: 4, cellHeight: 6, x: 0, y: 0 },
  } };
  const cursor = { row: 0, col: 1, focused: true, visible: false, blinkVisible: false,
    shape: "beam", preedit: renderFixture.cursor };
  const identityRows = [{ status: "matched", identity: { generation: "1", raster: "2", sequence: 3 } }];
  const result = evaluateVisualStages({ captures: [{ name: "frame-0001.bgra", capture: capture(data), identityRows }],
    sources: [source], stages: [{ key: "k-1", frame, render, cursor, semantic,
      cells: [{ row: 0, column: 0 }], glyphs: [{ row: 0, col: 0, grapheme: "A़", marked: true }] }],
    criteria: { colorDistance: 32, minimumGlyphPixels: 1, minimumUnderlineCoverage: 0.75 } });
  assert.equal(result[0].result, "measured");
  assert.deepEqual(result[0].candidates[0].identities, ["1/2/3"]);
  assert.deepEqual(result[0].candidates[0].issuedIdentities, ["1/2/3"]);
  assert.equal(result[0].candidates[0].glyphs[0].underlined, true);
  const malformed = evaluateVisualStages({ captures: [{ name: "frame-0001.bgra", capture: capture(data), identityRows }],
    sources: [source], stages: [{ key: "bad-frame", frame, render: { ...render,
      frame: { ...frame, sequence: frame.sequence + 1 } }, cursor, semantic,
    cells: [{ row: 0, column: 0 }], glyphs: [{ row: 0, col: 0, grapheme: "A़", marked: true }] }],
    criteria: { colorDistance: 32, minimumGlyphPixels: 1, minimumUnderlineCoverage: 0.75 } });
  assert.equal(malformed[0].result, "error");
  assert.match(malformed[0].errors[0].error, /different frame/);
  const unknown = evaluateVisualStages({ captures: [{ name: "frame-0001.bgra", capture: capture(data),
    identityRows: [{ status: "unknown", identity: null, reason: "unknown-retention" }] }],
  sources: [source], stages: [{ key: "unknown-identity", frame, render, cursor, semantic,
    cells: [{ row: 0, column: 0 }], glyphs: [{ row: 0, col: 0, grapheme: "A़", marked: true }] }],
  criteria: { colorDistance: 32, minimumGlyphPixels: 1, minimumUnderlineCoverage: 0.75 } });
  assert.equal(unknown[0].result, "no-proof");
  const issuedButUnmatchedPixels = evaluateVisualStages({ captures: [{ name: "frame-0001.bgra", capture: capture(data),
    identityRows: [{ status: "matched", identity: { generation: "9", raster: "2", sequence: 4 } }] }],
  sources: [source], stages: [{ key: "identity-without-byte-match", frame, render, cursor, semantic,
    cells: [{ row: 0, column: 0 }], glyphs: [{ row: 0, col: 0, grapheme: "A़", marked: true }] }],
  criteria: { colorDistance: 32, minimumGlyphPixels: 1, minimumUnderlineCoverage: 0.75 } });
  assert.equal(issuedButUnmatchedPixels[0].result, "no-proof");
});

testWithTimeout("error and no-proof measurements are persisted before the caller assertion fails", () => {
  const written = [];
  const measurements = [
    { key: "missing-candidate", result: "no-proof", reason: "no-capture-roi-candidate" },
    { key: "malformed-render", result: "error", errors: [{ error: "renderer frame differs" }] },
  ];
  const cadence = { longestFrameGap: 16, maximumFrameGap: 33,
    frameGaps: [{ from: "frame-0001.bgra", to: "frame-0002.bgra", milliseconds: 16 }] };
  assert.throws(() => persistThenRequireVisualProof(measurements, { visualMeasurements: measurements, cadence },
    (record) => written.push(record)), /rendered glyph\/underline proof is incomplete/);
  assert.deepEqual(written, [{ visualMeasurements: measurements, cadence }]);
});

testWithTimeout("visual results are persisted before cadence failure and both failures are reported", () => {
  let missingCadencePersisted = false;
  assert.throws(() => persistThenRequireVisualProof([{ key: "k-1", result: "measured" }],
    { visualMeasurements: [{ key: "k-1", result: "measured" }] },
    () => { missingCadencePersisted = true; }, "Tauri"), /cadence evidence is required/);
  assert.equal(missingCadencePersisted, false);

  const atLimit = { longestFrameGap: 33, maximumFrameGap: 33,
    frameGaps: [{ from: "frame-0001.bgra", to: "frame-0002.bgra", milliseconds: 33 }] };
  const completeMeasurements = [{ key: "k-1", result: "measured" }];
  const atLimitPersisted = [];
  assert.doesNotThrow(() => persistThenRequireVisualProof(completeMeasurements,
    { visualMeasurements: completeMeasurements, cadence: atLimit },
    (record) => atLimitPersisted.push(record), "Tauri"));
  assert.deepEqual(atLimitPersisted, [{ visualMeasurements: completeMeasurements, cadence: atLimit }]);

  const cadence = { longestFrameGap: 34, maximumFrameGap: 33,
    frameGaps: [{ from: "frame-0001.bgra", to: "frame-0002.bgra", milliseconds: 34 }] };
  const visualMeasurements = [{ key: "k-1", result: "measured" }];
  const persisted = [];
  assert.throws(() => persistThenRequireVisualProof(visualMeasurements,
    { visualMeasurements, cadence }, (record) => persisted.push(record), "Tauri"),
  /34ms frame gap/);
  assert.deepEqual(persisted, [{ visualMeasurements, cadence }]);

  const failedMeasurements = [{ key: "k-1", result: "no-proof", reason: "no-capture-roi-candidate" }];
  const failuresPersisted = [];
  assert.throws(() => persistThenRequireVisualProof(failedMeasurements,
    { visualMeasurements: failedMeasurements, cadence }, (record) => failuresPersisted.push(record), "Tauri"),
  (error) => error instanceof AggregateError && error.errors.length === 2 &&
    error.errors.some((failure) => /proof is incomplete/.test(failure.message)) &&
    error.errors.some((failure) => /34ms frame gap/.test(failure.message)));
  assert.deepEqual(failuresPersisted, [{ visualMeasurements: failedMeasurements, cadence }]);
});

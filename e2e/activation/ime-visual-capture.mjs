import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compositionFrameCandidates, measureRenderedCell } from "./terminal-ime-visual.mjs";
import { terminalComposeMatchesPreedit, visibleInputBeforeCursor } from "./terminal-ime-document.mjs";

const BGRA_PIXEL_FORMAT = 0x42475241;

function frameKey(frame, label) {
  assert.ok(frame && Number.isSafeInteger(frame.generation) && frame.generation > 0 &&
    Number.isSafeInteger(frame.raster) && frame.raster > 0 &&
    Number.isSafeInteger(frame.sequence) && frame.sequence > 0,
  `${label}: frame identity is invalid`);
  return `${frame.generation}/${frame.raster}/${frame.sequence}`;
}

function manifestFrame(artifact) {
  const frame = {
    generation: Number(artifact.generation),
    raster: Number(artifact.raster),
    sequence: artifact.sequence,
  };
  frameKey(frame, "source manifest");
  return frame;
}

function sameFrame(left, right) {
  return frameKey(left, "left frame") === frameKey(right, "right frame");
}

/** Reads the complete retained source set and attaches only exact frame-bound status snapshots. */
export function readRetainedSources(directory, frameStates) {
  const manifestPath = join(directory, "sources", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.format, 1, "capture source manifest format is unsupported");
  assert.equal(manifest.pixelFormat, "BGRA8", "capture source pixel format is unsupported");
  assert.equal(manifest.alpha, "premultiplied-first", "capture source alpha mode is unsupported");
  assert.equal(manifest.droppedSources, 0, "capture source retention dropped snapshots");
  assert.equal(manifest.writeFailures, 0, "capture source artifacts could not all be written");
  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0,
    "capture source manifest contains no retained rasters");

  const identities = new Set();
  const missingStates = [];
  const sources = manifest.artifacts.map((artifact) => {
    const frame = manifestFrame(artifact);
    const key = frameKey(frame, "source manifest");
    assert.ok(!identities.has(key), `capture source manifest repeats frame ${key}`);
    identities.add(key);
    assert.equal(artifact.pixelFormat, manifest.pixelFormat, `source ${key}: pixel format differs from manifest`);
    assert.equal(artifact.alpha, manifest.alpha, `source ${key}: alpha mode differs from manifest`);
    assert.ok(Number.isInteger(artifact.width) && artifact.width > 0 &&
      Number.isInteger(artifact.height) && artifact.height > 0 &&
      Number.isInteger(artifact.stride) && artifact.stride >= artifact.width * 4 &&
      Number.isSafeInteger(artifact.byteCount) && artifact.byteCount === artifact.stride * artifact.height,
    `source ${key}: raster dimensions or stride are invalid`);
    assert.ok(typeof artifact.file === "string" && artifact.file.length > 0,
      `source ${key}: raster filename is missing`);
    const data = readFileSync(join(directory, "sources", artifact.file));
    assert.equal(data.length, artifact.byteCount, `source ${key}: raster byte count differs from manifest`);
    assert.equal(createHash("sha256").update(data).digest("hex"), artifact.sha256,
      `source ${key}: raster digest differs from manifest`);
    const state = frameStates.get(key);
    const render = state?.render;
    if (state) {
      assert.equal(frameKey(state.frame, `source ${key} status`), key,
        `source ${key}: attached status belongs to another frame`);
      assert.equal(frameKey(render?.frame, `source ${key} render`), key,
        `source ${key}: render metadata belongs to another frame`);
      assert.equal(render.pixel.width, artifact.width, `source ${key}: renderer width differs from raster`);
      assert.equal(render.pixel.height, artifact.height, `source ${key}: renderer height differs from raster`);
      assert.equal(render.pixel.bytesPerRow, artifact.stride, `source ${key}: renderer stride differs from raster`);
    }
    const raster = {
      width: artifact.width,
      height: artifact.height,
      bytesPerRow: artifact.stride,
      data: new Uint8Array(data),
      format: artifact.pixelFormat,
      alpha: artifact.alpha,
      colorSpace: artifact.colorSpace,
      scale: artifact.scale,
      screenBounds: artifact.screenBounds,
      ...(render ? { grid: {
        rows: render.grid.rows,
        cols: render.grid.cols,
        cellWidth: render.grid.cellWidth,
        cellHeight: render.grid.cellHeight,
        x: render.grid.origin.x,
        y: render.grid.origin.y,
      } } : {}),
    };
    if (!state || !render) missingStates.push(key);
    return { frame, raster, ...(state ? { state: { frame, semantic: state.semantic }, render } : {}) };
  });
  return { sources, missingStates };
}

/** Builds the consumer capture DTO from one callback record and its decoded BGRA frame. */
export function captureFromCallback(decoded, callback) {
  const metadata = callback?.imageMatch?.captureFrame;
  assert.ok(metadata && typeof metadata === "object", "capture callback frame metadata is missing");
  assert.equal(metadata.pixelFormat, BGRA_PIXEL_FORMAT, "capture callback pixel format is not 32-bit BGRA");
  assert.ok(Number.isInteger(metadata.width) && metadata.width === decoded.width &&
    Number.isInteger(metadata.height) && metadata.height === decoded.height &&
    Number.isInteger(metadata.stride) && metadata.stride === decoded.stride,
  "capture callback dimensions or stride differ from its decoded frame");
  assert.ok(typeof metadata.colorSpace === "string" && metadata.colorSpace.length > 0,
    "capture callback color space is missing");
  assert.ok(Number.isFinite(metadata.scaleFactor) && metadata.scaleFactor > 0 &&
    metadata.scaleFactor === decoded.scale,
  "capture callback scale differs from its decoded frame");
  assert.ok(metadata.screenRect && metadata.contentRect,
    "capture callback screen or content rectangle is missing");
  const capture = {
    width: decoded.width,
    height: decoded.height,
    bytesPerRow: decoded.stride,
    data: decoded.data,
    format: "BGRA8",
    alpha: "premultiplied-first",
    colorSpace: metadata.colorSpace,
    scaleFactor: metadata.scaleFactor,
    screenRect: metadata.screenRect,
    contentRect: metadata.contentRect,
  };
  return capture;
}

/** Reads the declared diagnostic host clock, whose Darwin monotonic domain is CLOCK_UPTIME_RAW/mach absolute time. */
export async function hostClockBoundary(request) {
  assert.equal(typeof request, "function", "host clock boundary requires an endpoint request function");
  const reply = await request("diagnostics.clock", {});
  assert.ok(reply !== null && typeof reply === "object" && !Array.isArray(reply)
    && Object.keys(reply).length === 1 && Object.hasOwn(reply, "mono_ns"),
  "diagnostics.clock reply must contain only mono_ns");
  const value = reply.mono_ns;
  assert.ok(typeof value === "string" && /^[1-9][0-9]*$/.test(value),
    "diagnostics.clock mono_ns must be canonical positive decimal text");
  assert.ok(BigInt(value) <= 18_446_744_073_709_551_615n,
    "diagnostics.clock mono_ns must fit uint64");
  return { clockDomain: "mach-absolute", machAbsoluteNs: value };
}

/** Associates each decoded frame with one terminal key interval using the recorded Mach display time. */
export function capturesByInputStage(frameCallbacks, decodedFrames, stages) {
  assert.equal(frameCallbacks.length, decodedFrames.length,
    "captured frame callbacks and decoded frames must have a one-to-one mapping");
  const grouped = new Map(stages.map((stage) => [stage.key, []]));
  for (const stage of stages) {
    assert.equal(stage.clockDomain, "mach-absolute",
      `${stage.key}: input stage boundaries must use the mach-absolute clock domain`);
    assert.ok(/^\d+$/.test(stage.startedMachAbsoluteNs) && /^\d+$/.test(stage.endedMachAbsoluteNs),
      `${stage.key}: input stage Mach-absolute boundaries are invalid`);
    assert.ok(BigInt(stage.startedMachAbsoluteNs) < BigInt(stage.endedMachAbsoluteNs),
      `${stage.key}: input stage Mach-absolute boundaries are reversed`);
  }
  for (const [index, { callback, name }] of frameCallbacks.entries()) {
    const numerator = callback.machTimebaseNumerator;
    const denominator = callback.machTimebaseDenominator;
    assert.ok(Number.isSafeInteger(numerator) && numerator > 0 &&
      Number.isSafeInteger(denominator) && denominator > 0,
    `${name}: callback Mach timebase is invalid`);
    assert.ok(typeof callback.displayTime === "string" && /^\d+$/.test(callback.displayTime),
      `${name}: display time is missing`);
    const displayNs = BigInt(callback.displayTime) * BigInt(numerator) / BigInt(denominator);
    const decoded = decodedFrames[index];
    assert.ok(Number.isFinite(decoded.time) && Math.abs(Number(displayNs) / 1e6 - decoded.time) < 0.001,
      `${name}: decoded frame time differs from its callback display time`);
    const stage = stages.find(({ startedMachAbsoluteNs, endedMachAbsoluteNs }) => {
      const start = BigInt(startedMachAbsoluteNs);
      const end = BigInt(endedMachAbsoluteNs);
      return displayNs >= start && displayNs < end;
    });
    if (!stage) continue;
    grouped.get(stage.key).push({
      name,
      callback,
      decoded,
      displayTimeNs: displayNs.toString(),
      capture: captureFromCallback(decoded, callback),
    });
  }
  return grouped;
}

/** Persists every visual result before rejecting incomplete proof so the caller retains failure evidence. */
export function persistThenRequireVisualProof(measurements, record, persist, label = "rendered") {
  persist(record);
  assert.ok(measurements.every((result) => result.result === "measured"),
    `${label}: rendered glyph/underline proof is incomplete: ${JSON.stringify(measurements)}`);
}

/** Indexes frame-bound cursor metadata with only the latest earlier screen rows observed on the active status stream. */
export function indexFrameStatus(events, prompt, visibleInputBeforeCursor) {
  const states = new Map();
  const rejections = [];
  let compose = null;
  let screenStatus = null;
  let lastCursorFrame = null;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.name === "terminal.compose") {
      compose = event.value;
      continue;
    }
    if (event.name === "terminal.screen") {
      screenStatus = { index, rows: event.value };
      continue;
    }
    if (event.name !== "terminal.cursor") continue;
    const cursor = event.value;
    if (!cursor?.frame && !cursor?.render) continue;
    if (!cursor.frame || !cursor.render) {
      rejections.push({ eventIndex: index, reason: "cursor-frame-or-render-missing" });
      continue;
    }
    const key = frameKey(cursor.frame, "terminal.cursor");
    if (lastCursorFrame && cursor.frame.generation === lastCursorFrame.generation &&
        cursor.frame.raster === lastCursorFrame.raster && cursor.frame.sequence < lastCursorFrame.sequence) {
      rejections.push({ frame: key, eventIndex: index, reason: "cursor-frame-sequence-regressed" });
      continue;
    }
    if (!sameFrame(cursor.frame, cursor.render.frame)) {
      rejections.push({ frame: key, eventIndex: index, reason: "cursor-and-render-frame-differ" });
      continue;
    }
    lastCursorFrame = cursor.frame;
    if (screenStatus === null) {
      rejections.push({ frame: key, eventIndex: index, reason: "prior-screen-status-is-missing" });
      continue;
    }
    if (!compose || !terminalComposeMatchesPreedit(compose, cursor)) {
      rejections.push({ frame: key, eventIndex: index, reason: "compose-and-cursor-preedit-differ" });
      continue;
    }
    const rows = screenStatus.rows;
    if (!Array.isArray(rows)) {
      rejections.push({ frame: key, eventIndex: screenStatus.index, reason: "screen-rows-are-invalid" });
      continue;
    }
    const screen = { rows };
    let document;
    try {
      document = visibleInputBeforeCursor(screen, cursor, prompt, compose.text, `source frame ${key}`);
    } catch (error) {
      rejections.push({ frame: key, eventIndex: index, reason: "screen-state-cannot-be-read",
        error: error.message });
      continue;
    }
    const geometry = cursor.render.grid;
    const semantic = {
      document,
      compose: {
        text: compose.text,
        markedRange: compose.markedRange ?? null,
        selectedRange: compose.selectedRange ?? null,
        replacementRange: compose.replacementRange ?? null,
        attributed: compose.attributed,
      },
      cursor: {
        row: cursor.row,
        col: cursor.col,
        focused: cursor.focused,
        preedit: compose.text,
      },
      geometry: {
        rows: geometry.rows,
        cols: geometry.cols,
        cellWidth: geometry.cellWidth,
        cellHeight: geometry.cellHeight,
        origin: { x: geometry.origin.x, y: geometry.origin.y },
      },
    };
    states.set(key, { frame: cursor.frame, render: cursor.render, semantic,
      rows,
      eventIndexes: { screen: screenStatus.index, cursor: index },
      screenRowsReused: screenStatus.index !== index - 1 });
  }
  states.rejections = rejections;
  return states;
}

function displayColumnAfter(row, prefix, label) {
  let column = 0;
  let text = "";
  for (const cell of row) {
    assert.ok(Number.isInteger(cell.width) && cell.width >= 0, `${label}: terminal cell width is invalid`);
    text += cell.ch ?? " ".repeat(cell.width);
    column += cell.width;
    if (text === prefix) return column;
    assert.ok(prefix.startsWith(text), `${label}: prompt prefix does not end at a cell boundary`);
  }
  assert.fail(`${label}: prompt prefix is not visible in the source row`);
}

/** Builds the exact input ROI and glyph list from one screen/cursor/render observation. */
export function planVisualStage({ key, expectedDocument, observation, frameStatus, prompt }) {
  const { screen, compose, cursor } = observation;
  const render = cursor.render;
  assert.ok(cursor.frame && render?.frame, `${key}: frame-bound cursor render metadata is missing`);
  assert.deepEqual(render.frame, cursor.frame, `${key}: cursor render metadata belongs to another frame`);
  frameKey(cursor.frame, `${key} cursor`);
  frameKey(screen.frame, `${key} base screen`);
  assert.equal(screen.frame.generation, cursor.frame.generation, `${key}: screen and cursor generations differ`);
  assert.equal(screen.frame.raster, cursor.frame.raster, `${key}: screen and cursor rasters differ`);
  assert.ok(Number.isSafeInteger(screen.frame.sequence) && screen.frame.sequence <= cursor.frame.sequence,
    `${key}: base screen frame sequence is newer than the overlay cursor frame`);
  const presented = observation.presented;
  assert.ok(presented, `${key}: terminal observation has no presented frame`);
  frameKey(presented, `${key} presentation watermark`);
  assert.equal(presented.generation, cursor.frame.generation,
    `${key}: presentation watermark generation differs from the cursor frame`);
  assert.equal(presented.raster, cursor.frame.raster,
    `${key}: presentation watermark raster differs from the cursor frame`);
  assert.ok(Number.isSafeInteger(presented.sequence) && presented.sequence >= cursor.frame.sequence,
    `${key}: presentation watermark has not reached the cursor frame`);
  assert.ok(frameStatus instanceof Map, `${key}: indexed prior screen rows are required`);
  const rowSource = frameStatus.get(frameKey(cursor.frame, `${key} cursor`));
  assert.ok(rowSource, `${key}: no indexed prior screen rows for the cursor overlay frame`);
  assert.deepEqual(screen.rows, rowSource.rows,
    `${key}: screen-read rows differ from the active observer's indexed prior rows`);
  assert.equal(frameKey(rowSource.frame, `${key} indexed rows`), frameKey(cursor.frame, `${key} cursor`),
    `${key}: indexed rows belong to another cursor frame`);
  assert.equal(frameKey(rowSource.render?.frame, `${key} indexed render`), frameKey(cursor.frame, `${key} cursor`),
    `${key}: indexed render belongs to another cursor frame`);
  const screenEventIndex = rowSource.eventIndexes?.screen;
  const cursorEventIndex = rowSource.eventIndexes?.cursor;
  assert.ok(Number.isSafeInteger(screenEventIndex) && screenEventIndex >= 0 &&
    Number.isSafeInteger(cursorEventIndex) && cursorEventIndex > screenEventIndex,
  `${key}: indexed screen rows do not precede the cursor event`);
  assert.equal(rowSource.screenRowsReused, screenEventIndex !== cursorEventIndex - 1,
    `${key}: indexed screen row reuse provenance is inconsistent`);
  assert.equal(visibleInputBeforeCursor(screen, cursor, prompt, compose.text, key), expectedDocument,
    `${key}: terminal document differs from the AppKit reference`);
  assert.equal(cursor.row, prompt.row, `${key}: input wrapped across terminal rows`);
  const grid = render.grid;
  const inputStart = displayColumnAfter(screen.rows[prompt.row], prompt.text, `${key} prompt`);
  const expectedVowels = [...expectedDocument].filter((value) => value === "ㅏ").length;
  const visibleVowels = render.glyphs.filter((glyph) => glyph.row === prompt.row && glyph.col >= inputStart &&
    glyph.grapheme === "ㅏ").sort((left, right) => left.col - right.col);
  assert.equal(visibleVowels.length, expectedVowels,
    `${key}: renderer metadata does not name every expected Hangul glyph`);
  const marked = compose.markedRange;
  const preeditLength = [...compose.text].length;
  let markedCount = 0;
  if (marked !== null) {
    assert.equal(marked.location, 0, `${key}: marked range does not start at the current preedit`);
    assert.equal(marked.length, compose.text.length, `${key}: marked range does not cover the current preedit`);
    markedCount = preeditLength;
  }
  assert.ok(markedCount <= visibleVowels.length, `${key}: marked preedit exceeds the visible glyph span`);
  const inputGlyphs = visibleVowels.map((glyph, index) => ({ row: glyph.row, col: glyph.col,
    grapheme: glyph.grapheme, marked: index >= visibleVowels.length - markedCount }));
  const end = Math.max(cursor.col, ...visibleVowels.map((glyph) => glyph.col + glyph.width));
  const guard = end;
  assert.ok(inputStart < end && guard < grid.cols, `${key}: input span or trailing guard is outside the terminal grid`);
  const cells = Array.from({ length: guard - inputStart + 1 }, (_, offset) => ({
    row: prompt.row,
    column: inputStart + offset,
  }));
  const geometry = {
    rows: grid.rows,
    cols: grid.cols,
    cellWidth: grid.cellWidth,
    cellHeight: grid.cellHeight,
    origin: { x: grid.origin.x, y: grid.origin.y },
  };
  assert.deepEqual(rowSource.semantic, {
    document: expectedDocument,
    compose: {
      text: compose.text,
      markedRange: compose.markedRange ?? null,
      selectedRange: compose.selectedRange ?? null,
      replacementRange: compose.replacementRange ?? null,
      attributed: compose.attributed,
    },
    cursor: { row: cursor.row, col: cursor.col, focused: cursor.focused, preedit: compose.text },
    geometry,
  }, `${key}: indexed prior rows do not describe the current expected composition`);
  return {
    key,
    frame: cursor.frame,
    render,
    cursor,
    cells,
    glyphs: inputGlyphs,
    semantic: {
      document: expectedDocument,
      compose: {
        text: compose.text,
        markedRange: compose.markedRange ?? null,
        selectedRange: compose.selectedRange ?? null,
        replacementRange: compose.replacementRange ?? null,
        attributed: compose.attributed,
      },
      cursor: { row: cursor.row, col: cursor.col, focused: cursor.focused, preedit: compose.text },
      geometry,
    },
  };
}

/** Evaluates exact captured samples against every retained source and each expected stage. */
export function evaluateVisualStages({ captures, sources, stages, criteria }) {
  assert.ok(Array.isArray(stages) && stages.length > 0, "terminal input stages are required");
  const incomplete = sources.filter((source) => !source.state || !source.raster.grid || !source.render)
    .map((source) => frameKey(source.frame, "source"));
  if (incomplete.length) {
    return stages.map((stage) => ({ key: stage.key, result: "no-proof",
      reason: "retained-source-frame-state-incomplete", missingSourceStates: incomplete }));
  }

  const sourceByIdentity = new Map(sources.map((source) => [frameKey(source.frame, "source"), source]));
  return stages.map((stage) => {
    if (!captures.length) return { key: stage.key, result: "no-proof", reason: "no-capture-frame-in-input-interval" };
    const candidates = [];
    const errors = [];
    for (const sample of captures) {
      try {
        const result = compositionFrameCandidates({ targetFrame: stage.frame, capture: sample.capture,
          sources, cells: stage.cells, expectedState: stage.semantic });
        if (result.result !== "candidate-set") continue;
        const target = sourceByIdentity.get(frameKey(stage.frame, "stage"));
        assert.ok(target, `stage ${stage.key}: exact frame has no retained source raster`);
        const glyphs = stage.glyphs.map((glyph) => ({ ...glyph,
          ...measureRenderedCell(sample.capture, { ...target.raster, frame: target.frame }, stage.render, {
            frame: stage.frame,
            cursor: stage.cursor,
            row: glyph.row,
            col: glyph.col,
            grapheme: glyph.grapheme,
            marked: glyph.marked,
          }, criteria),
        }));
        candidates.push({ capture: sample.name, identities: result.identities,
          ambiguous: result.ambiguous, glyphs });
      } catch (error) {
        errors.push({ capture: sample.name, name: error.name, error: error.message });
      }
    }
    if (errors.length) return { key: stage.key, result: "error", errors, candidates };
    if (!candidates.length) return { key: stage.key, result: "no-proof", reason: "no-capture-roi-candidate" };
    const failed = candidates.find((candidate) => candidate.glyphs.some((glyph) => glyph.result !== "measured"));
    return { key: stage.key, result: failed ? "failed" : "measured", candidates };
  });
}

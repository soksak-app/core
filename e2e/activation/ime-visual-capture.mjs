import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compositionFrameCandidates, measureRenderedCell } from "./terminal-ime-visual.mjs";
import { terminalComposeMatchesPreedit, visibleInputBeforeCursor } from "./terminal-ime-document.mjs";

const BGRA_PIXEL_FORMAT = 0x42475241;
export const MAXIMUM_IME_FRAME_GAP_MS = 33;

export function requireImeRenderer(cursor) {
  if (cursor?.render == null) {
    const error = new Error("terminal renderer metadata is unavailable; start the diagnostic host with SOKSAK_VT_TRACE_DIR before input");
    error.code = "IME_RENDER_METADATA_UNAVAILABLE";
    throw error;
  }
  const identity = frameKey(cursor.frame, "terminal.cursor");
  assert.equal(frameKey(cursor.render.frame, "terminal.cursor.render"), identity,
    "terminal renderer metadata belongs to a different cursor frame");
  assert.ok(Array.isArray(cursor.render.glyphs), "terminal renderer metadata has no glyph list");
  return cursor.render;
}

export async function startImeCapture(session, cursor) {
  assert.equal(typeof session?.record, "function", "IME capture requires the declared window recording interface");
  const render = requireImeRenderer(cursor);
  const recording = await session.record({ frameIdentity: true });
  return { recording, render };
}

function identityTuple(value, label, exact = true) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}: identity tuple is missing`);
  if (exact) assert.deepEqual(Object.keys(value).sort(), ["generation", "raster", "sequence"],
    `${label}: identity tuple fields differ`);
  for (const field of ["generation", "raster"]) {
    assert.ok(typeof value[field] === "string" && /^[1-9][0-9]*$/.test(value[field]),
      `${label}: ${field} must be canonical positive decimal text`);
    assert.ok(BigInt(value[field]) <= 18_446_744_073_709_551_615n,
      `${label}: ${field} exceeds uint64`);
  }
  assert.ok(Number.isSafeInteger(value.sequence) && value.sequence > 0, `${label}: sequence is invalid`);
  return `${value.generation}/${value.raster}/${value.sequence}`;
}

function identityFrameNumber(value, label) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${label}: frame number is invalid`);
  return value;
}

/** Validates the opt-in decoder output without treating unknown rows as identities. */
export function readImeFrameIdentities(directory, stopResult) {
  const result = stopResult?.frameIdentity;
  assert.ok(result && typeof result === "object" && !Array.isArray(result),
    "capture stop did not return the requested frame identity result");
  assert.deepEqual(Object.keys(result).sort(), ["manifest", "status"], "frame identity result fields differ");
  assert.equal(result.status, "complete", "capture frame identity output is incomplete");
  const manifestPath = join(directory, "frame-identities", "manifest.json");
  assert.equal(result.manifest, manifestPath, "frame identity manifest path differs from the recording directory");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.format, 1, "frame identity manifest format is unsupported");
  assert.equal(manifest.pixelFormat, "BGRA8", "frame identity source pixel format is unsupported");
  assert.equal(manifest.decodedFramesFile, "decoded-frames.jsonl", "frame identity decoded file is unsupported");
  assert.equal(manifest.limits?.issuedIdentities, 512, "frame identity artifact limit differs");
  assert.equal(manifest.limits?.pendingArtifactBytes, 67_108_864, "frame identity pending-byte limit differs");
  for (const field of ["droppedArtifacts", "writeFailures", "cleanupFailures", "cleanupErrorsOmitted", "decodedWriteFailures"])
    assert.equal(manifest[field], 0, `frame identity ${field} is nonzero`);
  assert.deepEqual(manifest.cleanupErrors, [], "frame identity cleanup reported errors");
  assert.equal(manifest.identityFailure, null, "frame identity decoder reported a failure");
  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0,
    "frame identity manifest contains no issued source artifacts");

  const artifacts = new Map();
  let artifactBytes = 0;
  for (const artifact of manifest.artifacts) {
    const key = identityTuple(artifact, "frame identity artifact", false);
    assert.ok(!artifacts.has(key), `frame identity artifact ${key} is duplicated`);
    assert.ok(typeof artifact.regionToken === "string" && artifact.regionToken.length > 0,
      `frame identity artifact ${key} region token is missing`);
    assert.ok(typeof artifact.nonce === "string" && artifact.nonce.length > 0 &&
      typeof artifact.payload === "string" && artifact.payload.length > 0,
    `frame identity artifact ${key} issued payload is missing`);
    assert.ok(artifact.roi && ["x", "y", "width", "height"].every((field) => Number.isFinite(artifact.roi[field])) &&
      artifact.roi.width > 0 && artifact.roi.height > 0, `frame identity artifact ${key} ROI is invalid`);
    assert.equal(artifact.pixelFormat, "BGRA8", `frame identity artifact ${key} pixel format differs`);
    assert.equal(artifact.alpha, "premultiplied-first", `frame identity artifact ${key} alpha mode differs`);
    assert.ok(Number.isSafeInteger(artifact.width) && artifact.width > 0 &&
      Number.isSafeInteger(artifact.height) && artifact.height > 0 &&
      Number.isSafeInteger(artifact.stride) && artifact.stride >= artifact.width * 4 &&
      Number.isSafeInteger(artifact.byteCount) && artifact.byteCount === artifact.stride * artifact.height,
    `frame identity artifact ${key} dimensions or stride are invalid`);
    assert.ok(artifact.colorSpace === null || typeof artifact.colorSpace === "string",
      `frame identity artifact ${key} color space is invalid`);
    assert.ok(typeof artifact.file === "string" && artifact.file.length > 0 && !artifact.file.includes("/"),
      `frame identity artifact ${key} filename is invalid`);
    assert.ok(Number.isSafeInteger(artifact.byteCount) && artifact.byteCount > 0,
      `frame identity artifact ${key} byte count is invalid`);
    assert.ok(typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/.test(artifact.sha256),
      `frame identity artifact ${key} digest is invalid`);
    const bytes = readFileSync(join(directory, "frame-identities", artifact.file));
    assert.equal(bytes.length, artifact.byteCount, `frame identity artifact ${key} byte count differs`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256,
      `frame identity artifact ${key} digest differs`);
    artifactBytes += bytes.length;
    artifacts.set(key, artifact);
  }
  assert.equal(manifest.artifactBytes, artifactBytes, "frame identity artifact byte total differs");

  const decodedPath = join(directory, "frame-identities", manifest.decodedFramesFile);
  const decodedText = readFileSync(decodedPath, "utf8");
  assert.notEqual(decodedText.trim(), "", "frame identity decoder output is empty");
  const rows = decodedText.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, manifest.decodedRecords, "frame identity decoded record count differs");
  const byFrame = new Map();
  for (const row of rows) {
    const frame = identityFrameNumber(row.frame, "decoded frame identity");
    assert.ok(typeof row.displayTime === "string" && /^\d+$/.test(row.displayTime),
      `decoded frame ${frame}: display time is invalid`);
    assert.ok(row.region === null || (typeof row.region === "string" && row.region.length > 0),
      `decoded frame ${frame}: region is invalid`);
    assert.ok(row.roi === null || (row.roi && ["x", "y", "width", "height"].every((field) =>
      Number.isFinite(row.roi[field])) && row.roi.width > 0 && row.roi.height > 0),
    `decoded frame ${frame}: ROI is invalid`);
    if (row.status === "matched") {
      const key = identityTuple(row.identity, `decoded frame ${frame}`);
      assert.equal(row.reason, null, `decoded frame ${frame}: matched result has a reason`);
      const artifact = artifacts.get(key);
      assert.ok(artifact, `decoded frame ${frame}: identity ${key} was not issued in this capture`);
      assert.equal(row.region, artifact.regionToken,
        `decoded frame ${frame}: region does not match the issued identity artifact`);
    } else {
      assert.equal(row.status, "unknown", `decoded frame ${frame}: status is invalid`);
      assert.equal(row.identity, null, `decoded frame ${frame}: unknown result carries an identity`);
      assert.ok(["no-code", "cropped", "ambiguous", "unissued", "unknown-retention", "unknown-geometry", "duplicate-roi"]
        .includes(row.reason), `decoded frame ${frame}: unknown reason is invalid`);
    }
    const frameRows = byFrame.get(frame) ?? [];
    frameRows.push(row);
    byFrame.set(frame, frameRows);
  }
  assert.equal(byFrame.size, manifest.decodedFrames, "frame identity decoded frame count differs");
  const unknownRecords = rows.filter((row) => row.status === "unknown");
  return { byFrame, artifacts: [...artifacts.keys()], decodedFrames: manifest.decodedFrames,
    decodedRecords: rows.length, unknownRecords };
}

export function attachImeFrameIdentities(frameCallbacks, framePaths, identityCapture) {
  assert.ok(Array.isArray(frameCallbacks) && Array.isArray(framePaths), "capture frame callbacks and files are required");
  const files = new Map();
  for (const path of framePaths) {
    const name = path.split(/[\\/]/).at(-1);
    const match = /^frame-(\d+)\.bgra$/.exec(name);
    assert.ok(match, `captured frame filename is invalid: ${name}`);
    const number = identityFrameNumber(Number(match[1]), `captured frame ${name}`);
    assert.ok(!files.has(number), `captured frame number ${number} is duplicated`);
    files.set(number, name);
  }
  const callbackNumbers = new Set();
  const byFile = new Map();
  for (const { callback } of frameCallbacks) {
    const name = callback.frame;
    const match = typeof name === "string" && /^frame-(\d+)\.bgra$/.exec(name);
    assert.ok(match, `capture callback frame filename is invalid: ${String(name)}`);
    const number = identityFrameNumber(Number(match[1]), `capture callback ${name}`);
    assert.equal(files.get(number), name, `capture callback ${name} has no matching frame file`);
    assert.ok(!callbackNumbers.has(number), `capture callback frame ${number} is duplicated`);
    callbackNumbers.add(number);
    const rows = identityCapture.byFrame.get(number);
    assert.ok(rows?.length, `capture frame ${number} has no identity decoder record`);
    assert.ok(typeof callback.displayTime === "string" && /^\d+$/.test(callback.displayTime),
      `capture callback ${name} has no raw display time`);
    for (const row of rows) assert.equal(row.displayTime, callback.displayTime,
      `capture frame ${number}: identity display time differs from its callback`);
    byFile.set(name, rows);
  }
  assert.deepEqual([...callbackNumbers].sort((a, b) => a - b), [...files.keys()].sort((a, b) => a - b),
    "capture callback and frame identity numbers differ from retained frame files");
  assert.deepEqual([...identityCapture.byFrame.keys()].sort((a, b) => a - b), [...files.keys()].sort((a, b) => a - b),
    "frame identity decoder and retained frame files differ");
  return byFile;
}

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
  assert.equal(manifest.format, 2, "capture source manifest format is unsupported");
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
  for (const [index, { callback, name, identityRows }] of frameCallbacks.entries()) {
    assert.ok(Array.isArray(identityRows) && identityRows.length > 0,
      `${name}: decoded frame identity records are missing`);
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
      identityRows,
      displayTimeNs: displayNs.toString(),
      capture: captureFromCallback(decoded, callback),
    });
  }
  return grouped;
}

/** Requires cadence evidence, persists visual results, then rejects incomplete proof or cadence. */
export function persistThenRequireVisualProof(measurements, record, persist, label = "rendered") {
  const cadence = record?.cadence;
  assert.ok(cadence && typeof cadence === "object" && !Array.isArray(cadence),
    `${label}: cadence evidence is required`);
  assert.ok(Number.isFinite(cadence.longestFrameGap) && cadence.longestFrameGap >= 0 &&
    Array.isArray(cadence.frameGaps) && cadence.frameGaps.length > 0,
  `${label}: capture cadence evidence is invalid`);
  persist(record);
  const failures = [];
  if (!measurements.every((result) => result.result === "measured")) {
    failures.push(new Error(`${label}: rendered glyph/underline proof is incomplete: ${JSON.stringify(measurements)}`));
  }
  if (cadence.longestFrameGap > MAXIMUM_IME_FRAME_GAP_MS) {
    failures.push(new Error(`${label}: capture has a ${cadence.longestFrameGap}ms frame gap; ` +
      `maximum is ${MAXIMUM_IME_FRAME_GAP_MS}ms`));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures,
    `${label}: visual proof and capture cadence both failed`);
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
        const candidateIdentities = new Set(result.identities);
        const issuedMatches = sample.identityRows.filter((row) => row.status === "matched")
          .map((row) => identityTuple(row.identity, `capture ${sample.name}`))
          .filter((identity) => candidateIdentities.has(identity));
        if (!issuedMatches.length) continue;
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
        candidates.push({ capture: sample.name, identities: result.identities, issuedIdentities: issuedMatches,
          unknownIdentityRows: sample.identityRows.filter((row) => row.status === "unknown"),
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

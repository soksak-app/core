import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compositionFrameCandidates, measureRenderedCell } from "./terminal-ime-visual.mjs";
import { terminalComposeMatchesPreedit, visibleInputBeforeCursor, visibleInputFromRows }
  from "./terminal-ime-document.mjs";

const BGRA_PIXEL_FORMAT = 0x42475241;

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
    const identity = identityTuple(artifact, "frame identity artifact", false);
    const key = `${identity}@${String(artifact.regionToken)}`;
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
    assert.ok(!artifacts.has(key), `frame identity artifact ${key} is duplicated`);
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
      const artifact = artifacts.get(`${key}@${row.region}`);
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
  return { byFrame, artifacts: [...artifacts.values()].map((artifact) =>
      identityTuple(artifact, "frame identity artifact", false)), artifactRecords: [...artifacts.values()],
    decodedFrames: manifest.decodedFrames,
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

function semanticRasterColorSpace(name) {
  assert.ok(name === "sRGB" || name === "kCGColorSpaceSRGB",
    `unsupported raster color space: ${String(name)}`);
  return name === "kCGColorSpaceSRGB" ? "sRGB" : name;
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
      colorSpace: semanticRasterColorSpace(artifact.colorSpace),
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
    colorSpace: semanticRasterColorSpace(metadata.colorSpace),
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

/** Persists cadence measurements and rejects incomplete functional visual proof. */
export function persistThenRequireVisualProof(measurements, record, persist, label = "rendered") {
  const cadence = record?.cadence;
  assert.ok(cadence && typeof cadence === "object" && !Array.isArray(cadence),
    `${label}: cadence evidence is required`);
  assert.ok(Number.isFinite(cadence.longestFrameGap) && cadence.longestFrameGap >= 0 &&
    Array.isArray(cadence.frameGaps) && cadence.frameGaps.length > 0,
  `${label}: capture cadence evidence is invalid`);
  persist(record);
  const failures = [];
  const tagScopedMode = measurements.some((result) => Object.hasOwn(result, "tagScoped"));
  if (tagScopedMode && !measurements.every((result) => result.tagScoped &&
      typeof result.tagScoped.result === "string")) {
    failures.push(new Error(`${label}: tag-scoped proof record is missing or malformed`));
  }
  if (!measurements.every((result) => (tagScopedMode ? result.tagScoped?.result : result.result) === "measured")) {
    failures.push(new Error(`${label}: rendered glyph/underline proof is incomplete: ${JSON.stringify(measurements)}`));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures,
    `${label}: visual proof contains multiple failures`);
}

/** Persists the actual terminal input end boundary before later collection can fail. */
export function sealTerminalSequenceEndBoundary(boundary, stages, persist) {
  assert.ok(boundary && typeof boundary === "object" && !Array.isArray(boundary) &&
    boundary.clockDomain === "mach-absolute" && typeof boundary.machAbsoluteNs === "string" &&
    /^[1-9][0-9]*$/.test(boundary.machAbsoluteNs) &&
    BigInt(boundary.machAbsoluteNs) <= 18_446_744_073_709_551_615n,
  "terminal sequence end boundary is invalid");
  assert.ok(Array.isArray(stages) && stages.length > 0, "terminal visual stages are required to seal the boundary");
  assert.equal(typeof persist, "function", "terminal sequence boundary requires a persistence function");
  const sealedStages = stages.map((stage, index) => {
    assert.equal(stage.clockDomain, boundary.clockDomain, `${stage.key}: terminal stage clock domain differs`);
    assert.ok(typeof stage.startedMachAbsoluteNs === "string" && /^[1-9][0-9]*$/.test(stage.startedMachAbsoluteNs),
      `${stage.key}: terminal stage start boundary is invalid`);
    const endedMachAbsoluteNs = stages[index + 1]?.startedMachAbsoluteNs ?? boundary.machAbsoluteNs;
    assert.ok(typeof endedMachAbsoluteNs === "string" && /^[1-9][0-9]*$/.test(endedMachAbsoluteNs) &&
      BigInt(stage.startedMachAbsoluteNs) < BigInt(endedMachAbsoluteNs),
    `${stage.key}: terminal stage interval is invalid`);
    return { key: stage.key, clockDomain: boundary.clockDomain,
      startedMachAbsoluteNs: stage.startedMachAbsoluteNs, endedMachAbsoluteNs };
  });
  const record = { boundary: { clockDomain: boundary.clockDomain, machAbsoluteNs: boundary.machAbsoluteNs },
    stages: sealedStages };
  persist(record);
  return sealedStages;
}

/**
 * Joins complete sidecar screen bodies to the accepted page frame records in one sealed event-log range.
 * The host body supplies pixels' source state; the page marker proves that the matching screen message passed validation.
 */
export function indexAcceptedFrameTrace(events, prompt, surface, session) {
  assert.ok(Array.isArray(events), "accepted frame trace requires event records");
  assert.ok(typeof surface === "string" && surface.length > 0, "accepted frame trace requires a surface");
  assert.ok(typeof session === "string" && session.length > 0, "accepted frame trace requires a terminal session");
  const layers = new Set(["native", "host", "page", "plugin", "sidecar", "sok"]);
  const losses = events.filter((event) => {
    const fields = event.fields;
    if (!["log.gated", "page.log.gated", "native.log.gated", "log.dropped", "log.pruned",
      "host.buffer.dropped"].includes(event.event)) return false;
    assert.ok(layers.has(event.layer), `${event.event} has an unknown or missing producer layer`);
    assert.ok(fields && typeof fields === "object" && !Array.isArray(fields),
      `${event.event} has malformed loss metadata`);
    if (["log.gated", "page.log.gated", "native.log.gated"].includes(event.event)) {
      assert.ok(typeof fields.class === "string" && typeof fields.level === "string" &&
        Number.isSafeInteger(fields.count) && fields.count > 0, `${event.event} has malformed gate metadata`);
      const expectedLayer = event.event === "page.log.gated" ? "page" :
        event.event === "native.log.gated" ? "native" : event.layer;
      assert.equal(event.layer, expectedLayer, `${event.event} has a mismatched producer layer`);
      if (event.event === "log.gated") assert.ok(["host", "sidecar", "sok"].includes(event.layer),
        "log.gated has a producer layer without a writer gate");
      if (event.layer === "host") return fields.level === "debug" &&
        (fields.class === "call" || fields.class === "frame");
      return event.layer === "page" && fields.class === "frame" && fields.level === "debug";
    }
    if (event.event === "host.buffer.dropped") {
      assert.equal(event.layer, "host", "host.buffer.dropped has a mismatched producer layer");
      return true;
    }
    assert.ok(["host", "sidecar", "sok"].includes(event.layer),
      `${event.event} has a producer layer without a log writer`);
    return event.layer === "host";
  });
  assert.equal(losses.length, 0, `frame trace range reports log loss: ${JSON.stringify(losses)}`);

  const truncatedReceives = events.filter((event) => event.event === "host.trace.sidecar.receive" &&
    (event.fields?.surface === surface || event.fields?.surface === undefined) && event.truncated !== undefined);
  assert.equal(truncatedReceives.length, 0,
    `frame trace has truncated host screen bodies: ${JSON.stringify(truncatedReceives.map(({ seq }) => seq))}`);
  const receives = events.filter((event) => event.event === "host.trace.sidecar.receive" &&
    event.fields?.surface === surface && event.fields?.body?.event === "screen");
  const markers = events.filter((event) => event.event === "plugin.terminal.frame" &&
    event.fields?.session === session);
  const groupKey = (segment, sequence, identity) => JSON.stringify([surface, session, segment, sequence, identity]);
  const receiveGroups = new Map();
  const markerGroups = new Map();
  const validatedFrame = (frame, label) => {
    if (frame === null) return null;
    assert.deepEqual(Object.keys(frame).sort(), ["generation", "raster", "sequence"],
      `${label}: frame tuple fields differ`);
    return frameKey(frame, label);
  };
  for (const receive of receives) {
    const body = receive.fields.body;
    assert.ok(typeof body.segment === "string" && body.segment.length > 0,
      `host screen event ${receive.seq}: segment is missing`);
    assert.ok(Number.isSafeInteger(body.sequence) && body.sequence > 0,
      `host screen event ${receive.seq}: sequence is invalid`);
    assert.ok(Object.hasOwn(body, "frame"), `host screen event ${receive.seq}: frame is missing`);
    const identity = validatedFrame(body.frame, `host screen event ${receive.seq}.frame`);
    const key = groupKey(body.segment, body.sequence, identity);
    const group = receiveGroups.get(key) ?? { segment: body.segment, sequence: body.sequence,
      identity, frame: body.frame, receives: [] };
    group.receives.push(receive);
    receiveGroups.set(key, group);
  }
  for (const marker of markers) {
    const fields = marker.fields;
    assert.ok(typeof fields?.segment === "string" && fields.segment.length > 0,
      `plugin frame event ${marker.seq}: segment is missing`);
    assert.ok(Number.isSafeInteger(fields.sequence) && fields.sequence > 0,
      `plugin frame event ${marker.seq}: sequence is invalid`);
    assert.ok(Object.hasOwn(fields, "frame"), `plugin frame event ${marker.seq}: frame is missing`);
    if (fields.surface !== undefined) assert.equal(fields.surface, surface,
      `plugin frame event ${marker.seq}: surface differs`);
    const identity = validatedFrame(fields.frame, `plugin frame event ${marker.seq}.frame`);
    const key = groupKey(fields.segment, fields.sequence, identity);
    const group = markerGroups.get(key) ?? { segment: fields.segment, sequence: fields.sequence,
      identity, frame: fields.frame, markers: [] };
    group.markers.push(marker);
    markerGroups.set(key, group);
  }
  const unjoinedMessages = [];
  for (const group of receiveGroups.values()) {
    if (markerGroups.has(groupKey(group.segment, group.sequence, group.identity))) continue;
    unjoinedMessages.push({ session, segment: group.segment, sequence: group.sequence, frame: group.frame,
      producer: "host-screen-body", reason: "no-accepted-frame-marker" });
  }
  for (const group of markerGroups.values()) {
    if (receiveGroups.has(groupKey(group.segment, group.sequence, group.identity))) continue;
    unjoinedMessages.push({ session, segment: group.segment, sequence: group.sequence, frame: group.frame,
      producer: "accepted-frame-marker", reason: "no-host-screen-body" });
  }
  unjoinedMessages.sort((left, right) => left.sequence - right.sequence || left.producer.localeCompare(right.producer));

  const statusEvents = [];
  const acceptedByFrame = new Map();
  const noRasterMessages = [];
  const frameHashes = new Map();
  for (const [key, messageReceives] of receiveGroups) {
    const messageMarkers = markerGroups.get(key)?.markers;
    if (!messageMarkers?.length) continue;
    const orderedReceives = [...messageReceives.receives].sort((left, right) => left.seq - right.seq);
    const orderedMarkers = [...messageMarkers].sort((left, right) => left.seq - right.seq);
    const frameIdentity = messageReceives.identity;
    let baseMessage = null;
    for (const receive of orderedReceives) {
      const label = `host screen event ${receive.seq}`;
      assert.equal(receive.level, "debug", `${label}: performance trace body was not recorded at DEBUG`);
      assert.equal(receive.class, "call", `${label}: screen body has the wrong event class`);
      assert.ok(Number.isSafeInteger(receive.seq) && receive.seq > 0, `${label}: host sequence is invalid`);
      assert.equal(receive.truncated, undefined, `${label}: host event fields are truncated`);
      const body = receive.fields.body;
      assert.equal(body.event, "screen", `${label}: body is not a screen message`);
      assert.equal(body.segment, messageReceives.segment, `${label}: segment differs from its message key`);
      assert.equal(body.sequence, messageReceives.sequence, `${label}: sequence differs from its message key`);
      assert.deepEqual(body.frame, messageReceives.frame, `${label}: frame tuple differs from its message key`);
      assert.ok(Number.isInteger(body.rows) && body.rows > 0 && Number.isInteger(body.cols) && body.cols > 0,
        `${label}: screen dimensions are invalid`);
      assert.ok(Array.isArray(body.cells) && body.cells.length === body.rows * body.cols,
        `${label}: complete screen cells are missing`);
      assert.ok(body.cursor && typeof body.cursor === "object" && !Array.isArray(body.cursor),
        `${label}: cursor is missing`);
      const frameMessage = { frame: body.frame, rows: body.rows, cols: body.cols, cells: body.cells,
        cursor: { row: body.cursor.row, col: body.cursor.col, visible: body.cursor.visible } };
      if (baseMessage === null) baseMessage = frameMessage;
      else assert.deepEqual(frameMessage, baseMessage,
        `${label}: repeated native frame tuple changes its screen cells or engine cursor`);
      const compose = body.cursor.preedit ?? { text: "", markedRange: null, selectedRange: null,
        replacementRange: null, attributed: false };
      assert.ok(compose && typeof compose.text === "string", `${label}: preedit snapshot is invalid`);
      const render = body.render ?? null;
      if (frameIdentity === null) {
        assert.equal(render, null, `${label}: a no-raster screen message has renderer metadata`);
        continue;
      }
      if (render !== null) {
        assert.ok(render && typeof render === "object" && !Array.isArray(render),
          `${label}: renderer metadata is invalid`);
        assert.equal(frameKey(render.frame, `${label}.render.frame`), frameIdentity,
          `${label}: renderer metadata belongs to another frame`);
        assert.ok(Array.isArray(render.glyphs), `${label}: renderer glyph list is missing`);
      }
      const rows = Array.from({ length: body.rows }, () => []);
      for (let index = 0; index < body.cells.length; index++) {
        const cell = body.cells[index];
        assert.ok(cell && typeof cell === "object" && typeof cell.grapheme === "string" &&
          Number.isInteger(cell.width) && cell.width >= 0, `${label}: cell ${index} is invalid`);
        rows[Math.floor(index / body.cols)].push({
          ...(cell.grapheme === "" ? {} : { ch: cell.grapheme }), width: cell.width,
        });
      }
      const cursor = { ...body.cursor, frame: body.frame, render };
      statusEvents.push({ name: "terminal.screen", value: rows });
      statusEvents.push({ name: "terminal.compose", value: compose });
      statusEvents.push({ name: "terminal.cursor", value: cursor });
    }
    const markerHashes = new Set();
    for (const marker of orderedMarkers) {
      const label = `plugin frame event ${marker.seq}`;
      assert.equal(marker.level, "debug", `${label}: accepted frame marker was not DEBUG`);
      assert.equal(marker.class, "frame", `${label}: accepted frame marker has the wrong class`);
      assert.ok(Number.isSafeInteger(marker.seq) && marker.seq > 0, `${label}: accepted marker sequence is invalid`);
      assert.equal(marker.truncated, undefined, `${label}: accepted hash marker is truncated`);
      assert.equal(marker.fields.session, session, `${label}: session differs`);
      assert.equal(marker.fields.segment, messageReceives.segment, `${label}: segment differs`);
      assert.equal(marker.fields.sequence, messageReceives.sequence, `${label}: message sequence differs`);
      assert.deepEqual(marker.fields.frame, messageReceives.frame, `${label}: native frame tuple differs from its screen body`);
      assert.equal(marker.fields.rows, baseMessage.rows, `${label}: row count differs from the screen body`);
      assert.equal(marker.fields.cols, baseMessage.cols, `${label}: column count differs from the screen body`);
      assert.match(marker.fields.hash ?? "", /^[a-f0-9]{64}$/, `${label}: screen hash is invalid`);
      markerHashes.add(marker.fields.hash);
    }
    assert.equal(markerHashes.size, 1, `${key}: repeated accepted records have conflicting screen hashes`);
    const hash = markerHashes.values().next().value;
    if (frameIdentity === null) {
      noRasterMessages.push({ session, segment: messageReceives.segment, sequence: messageReceives.sequence,
        reason: "screen-message-has-no-native-frame", receiveSeqs: orderedReceives.map(({ seq }) => seq),
        markerSeqs: orderedMarkers.map(({ seq }) => seq) });
      continue;
    }
    const previousHash = frameHashes.get(frameIdentity);
    if (previousHash !== undefined) assert.equal(hash, previousHash,
      `${key}: one native frame tuple has conflicting screen hashes`);
    frameHashes.set(frameIdentity, hash);
    const accepted = acceptedByFrame.get(frameIdentity) ?? [];
    accepted.push({ session, segment: messageReceives.segment, sequence: messageReceives.sequence,
      frame: messageReceives.frame, hash, receiveSeqs: orderedReceives.map(({ seq }) => seq),
      markerSeqs: orderedMarkers.map(({ seq }) => seq) });
    acceptedByFrame.set(frameIdentity, accepted);
  }
  const states = indexFrameStatus(statusEvents, prompt);
  for (const [key, state] of states) {
    const accepted = acceptedByFrame.get(key);
    assert.ok(accepted?.length, `frame ${key} has status but no accepted message marker`);
    state.accepted = accepted;
  }
  states.noRasterMessages = noRasterMessages;
  states.unjoinedMessages = unjoinedMessages;
  return states;
}

/** Indexes frame-bound cursor metadata with only the latest earlier screen rows observed on the active status stream. */
export function indexFrameStatus(events, prompt) {
  const states = new Map();
  const conflicts = new Map();
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
    let document;
    try {
      document = visibleInputFromRows(rows, cursor, prompt, compose.text, `source frame ${key}`);
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
    const indexed = { frame: cursor.frame, render: cursor.render, semantic,
      rows,
      eventIndexes: { screen: screenStatus.index, cursor: index },
      screenRowsReused: screenStatus.index !== index - 1 };
    const previous = states.get(key);
    if (previous) {
      if (!sameIndexedFrameState(previous, indexed)) {
        conflicts.set(key, { frame: key, eventIndexes: [previous.eventIndexes.cursor, index],
          reason: "conflicting-status-for-frame-tuple" });
        states.delete(key);
      }
    } else if (!conflicts.has(key)) states.set(key, indexed);
  }
  states.rejections = rejections;
  states.conflicts = conflicts;
  return states;
}

function sameIndexedFrameState(left, right) {
  try {
    assert.deepEqual(left.rows, right.rows);
    assert.deepEqual(left.semantic, right.semantic);
    assert.deepEqual(left.render, right.render);
    return true;
  } catch {
    return false;
  }
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
  const observedRender = cursor.render;
  assert.ok(cursor.frame, `${key}: frame-bound cursor identity is missing`);
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
  const render = rowSource.render;
  assert.ok(render?.frame, `${key}: indexed frame-bound renderer metadata is missing`);
  assert.deepEqual(render.frame, cursor.frame, `${key}: indexed renderer metadata belongs to another cursor frame`);
  if (observedRender !== null && observedRender !== undefined) {
    assert.deepEqual(observedRender, render,
      `${key}: observed renderer metadata differs from the indexed exact-tuple renderer`);
  }
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
    observationRender: observedRender ?? null,
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
function mappedIdentityROI(artifact, source, capture) {
  const bounds = source.raster.screenBounds;
  const scale = source.raster.scale;
  assert.ok(bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    Number.isFinite(scale) && scale > 0, "tag target source geometry is invalid");
  assert.equal(bounds.width * scale, source.raster.width, "tag target source width differs from its screen bounds");
  assert.equal(bounds.height * scale, source.raster.height, "tag target source height differs from its screen bounds");
  const roi = artifact.roi;
  assert.ok(roi && [roi.x, roi.y, roi.width, roi.height].every(Number.isFinite) &&
    roi.x >= 0 && roi.y >= 0 && roi.width > 0 && roi.height > 0 &&
    roi.x + roi.width <= source.raster.width && roi.y + roi.height <= source.raster.height,
  "issued tag ROI is outside its source raster");
  const screen = capture.screenRect;
  const content = capture.contentRect;
  const mapped = {
    x: content.x + (bounds.x - screen.x + roi.x / scale) * capture.scaleFactor,
    y: content.y + (bounds.y - screen.y + roi.y / scale) * capture.scaleFactor,
    width: roi.width / scale * capture.scaleFactor,
    height: roi.height / scale * capture.scaleFactor,
  };
  assert.ok(Object.values(mapped).every(Number.isInteger), "issued tag ROI maps to fractional capture pixels");
  assert.ok(mapped.x >= 0 && mapped.y >= 0 && mapped.x + mapped.width <= capture.width &&
    mapped.y + mapped.height <= capture.height, "issued tag ROI maps outside the captured frame");
  return mapped;
}

function mappedStageCell(cell, source, capture) {
  const { grid } = source.raster;
  const { screenBounds: bounds, scale } = source.raster;
  const screen = capture.screenRect;
  const content = capture.contentRect;
  const rect = {
    x: content.x + (bounds.x - screen.x + (grid.x + cell.column * grid.cellWidth) / scale) * capture.scaleFactor,
    y: content.y + (bounds.y - screen.y + (grid.y + cell.row * grid.cellHeight) / scale) * capture.scaleFactor,
    width: grid.cellWidth / scale * capture.scaleFactor,
    height: grid.cellHeight / scale * capture.scaleFactor,
  };
  assert.ok(Object.values(rect).every(Number.isInteger), "target glyph/guard cell maps to fractional capture pixels");
  return rect;
}

function rectanglesOverlap(left, right) {
  return left.x < right.x + right.width && right.x < left.x + left.width &&
    left.y < right.y + right.height && right.y < left.y + left.height;
}

function evaluateTagScopedStage({ captures, sources, stage, criteria, tagArtifacts, statusConflicts }) {
  const targetIdentity = frameKey(stage.frame, `${stage.key} target`);
  const target = sources.find((source) => frameKey(source.frame, `${stage.key} source`) === targetIdentity);
  if (!target || !target.state || !target.render || !target.raster.grid) {
    return { result: "no-proof", reason: "tag-target-source-state-incomplete", samples: [] };
  }
  if (statusConflicts?.has(targetIdentity)) {
    return { result: "no-proof", reason: "tag-target-frame-status-conflicts", samples: [],
      conflict: statusConflicts.get(targetIdentity) };
  }
  if (frameKey(target.state.frame, `${stage.key} target status`) !== targetIdentity ||
      frameKey(target.render.frame, `${stage.key} target render`) !== targetIdentity) {
    return { result: "no-proof", reason: "tag-target-frame-identity-differs", samples: [] };
  }
  try {
    assert.deepEqual(target.render, stage.render,
      `${stage.key}: stage render differs from the indexed exact-tuple render`);
    if (stage.observationRender !== null && stage.observationRender !== undefined) {
      assert.deepEqual(stage.observationRender, target.render,
        `${stage.key}: observed render differs from the indexed exact-tuple render`);
    }
    assert.deepEqual(target.state.semantic, stage.semantic,
      `${stage.key}: observed semantic state differs from the indexed exact-tuple state`);
  } catch (error) {
    return { result: "no-proof", reason: "tag-target-indexed-state-differs", samples: [],
      error: error.message };
  }
  const exactArtifacts = tagArtifacts.filter((artifact) =>
    identityTuple(artifact, `${stage.key} issued tag artifact`, false) === targetIdentity);
  const samples = [];
  for (const sample of captures) {
    const rows = sample.identityRows;
    try {
      assert.ok(Array.isArray(rows), `${sample.name}: decoded identity rows are missing`);
      assert.ok(Array.isArray(stage.cells) && stage.cells.length > 0,
        `${stage.key}: input span and guard cells are required`);
      const targetRows = rows.filter((row) => row.status === "matched" &&
        identityTuple(row.identity, `${sample.name} decoded identity`) === targetIdentity);
      if (!targetRows.length) {
        samples.push({ frame: sample.name, result: "no-proof", reason: "tag-target-row-missing",
          targetRowCount: 0, identityRows: rows });
        continue;
      }
      const historyDropMarkers = rows.filter((row) => row.status === "unknown" && row.reason === "unknown-retention" &&
        row.region === null && row.roi === null);
      const unlocatedUnknown = rows.filter((row) => row.status === "unknown" && row.roi === null);
      if (unlocatedUnknown.length) {
        samples.push({ frame: sample.name, result: "no-proof", reason: "unknown-roi-cannot-be-ruled-out",
          identityRows: rows });
        continue;
      }
      const crop = compositionFrameCandidates({ targetFrame: stage.frame, capture: sample.capture,
        sources: [target], cells: stage.cells, expectedState: stage.semantic });
      assert.equal(crop.result, "candidate-set", `${sample.name}: target span and guard crop is not byte-equal`);
      const validAttributions = [];
      for (const targetRow of targetRows) {
        const matchingArtifacts = exactArtifacts.filter((candidate) => candidate.regionToken === targetRow.region &&
          typeof candidate.nonce === "string" && candidate.nonce.length > 0 &&
          typeof candidate.payload === "string" && candidate.payload.length > 0);
        if (matchingArtifacts.length !== 1) continue;
        const candidateArtifact = matchingArtifacts[0];
        try {
          assert.equal(candidateArtifact.width, target.raster.width,
            `${sample.name}: issued identity width differs from retained source`);
          assert.equal(candidateArtifact.height, target.raster.height,
            `${sample.name}: issued identity height differs from retained source`);
          assert.equal(candidateArtifact.stride, target.raster.bytesPerRow,
            `${sample.name}: issued identity stride differs from retained source`);
          assert.equal(candidateArtifact.pixelFormat, target.raster.format,
            `${sample.name}: issued identity pixel format differs from retained source`);
          assert.equal(candidateArtifact.alpha, target.raster.alpha,
            `${sample.name}: issued identity alpha mode differs from retained source`);
          assert.equal(semanticRasterColorSpace(candidateArtifact.colorSpace), target.raster.colorSpace,
            `${sample.name}: issued identity color space differs from retained source`);
          assert.equal(candidateArtifact.byteCount, target.raster.data.byteLength,
            `${sample.name}: issued identity byte count differs from retained source`);
        } catch (error) {
          samples.push({ frame: sample.name, result: "no-proof",
            reason: "tag-artifact-source-raster-metadata-differs", error: error.message,
            identityRows: rows });
          continue;
        }
        const projectedROI = mappedIdentityROI(candidateArtifact, target, sample.capture);
        assert.deepEqual(targetRow.roi, projectedROI,
          `${sample.name}: decoded target ROI differs from the projected issued ROI`);
        for (const cell of stage.cells) {
          assert.ok(!rectanglesOverlap(projectedROI, mappedStageCell(cell, target, sample.capture)),
            `${sample.name}: issued tag ROI overlaps the input span or guard cells`);
        }
        const conflicts = rows.filter((row) => row !== targetRow && row.roi &&
          rectanglesOverlap(row.roi, projectedROI));
        if (conflicts.length) continue;
        validAttributions.push({ artifact: candidateArtifact, projectedROI });
      }
      if (validAttributions.length !== 1) {
        samples.push({ frame: sample.name, result: "no-proof", reason: "tag-target-attribution-not-unique",
          attributionCount: validAttributions.length, identityRows: rows });
        continue;
      }
      const { artifact, projectedROI } = validAttributions[0];
      const glyphs = stage.glyphs.map((glyph) => ({ ...glyph,
        ...measureRenderedCell(sample.capture, { ...target.raster, frame: target.frame }, target.render, {
          frame: target.frame, cursor: stage.cursor, row: glyph.row, col: glyph.col,
          grapheme: glyph.grapheme, marked: glyph.marked,
        }, criteria),
      }));
      const failedGlyph = glyphs.find((glyph) => glyph.result !== "measured");
      samples.push({ frame: sample.name, result: failedGlyph ? "failed" : "measured",
        identity: targetIdentity, regionToken: artifact.regionToken, nonce: artifact.nonce,
        payload: artifact.payload,
        issuedArtifact: { file: artifact.file, sha256: artifact.sha256, roi: artifact.roi },
        decodedRow: targetRows.find((row) => row.region === artifact.regionToken),
        projectedROI, crop: { result: crop.result, identities: crop.identities,
          ambiguous: crop.ambiguous }, glyphs,
        unknownIdentityRows: rows.filter((row) => row.status === "unknown"), historyDropMarkers });
    } catch (error) {
      samples.push({ frame: sample.name, result: "no-proof", reason: "tag-sample-validation-failed",
        error: error.message, identityRows: rows });
    }
  }
  return { result: samples.some((sample) => sample.result === "measured") ? "measured" : "no-proof", samples };
}

/** Evaluates raw crop evidence and, when supplied, keeps tag-scoped proof separate. */
export function evaluateVisualStages({ captures, sources, stages, criteria, tagArtifacts, statusConflicts }) {
  assert.ok(Array.isArray(stages) && stages.length > 0, "terminal input stages are required");
  const incomplete = sources.filter((source) => !source.state || !source.raster.grid || !source.render)
    .map((source) => frameKey(source.frame, "source"));
  if (incomplete.length) {
    return stages.map((stage) => {
      const raw = { key: stage.key, result: "no-proof",
        reason: "retained-source-frame-state-incomplete", missingSourceStates: incomplete };
      if (!tagArtifacts) return raw;
      return { ...raw, tagScoped: evaluateTagScopedStage({ captures, sources, stage, criteria,
        tagArtifacts, statusConflicts }) };
    });
  }

  const sourceByIdentity = new Map(sources.map((source) => [frameKey(source.frame, "source"), source]));
  return stages.map((stage) => {
    if (!captures.length) {
      const raw = { key: stage.key, result: "no-proof", reason: "no-capture-frame-in-input-interval" };
      if (!tagArtifacts) return raw;
      return { ...raw, tagScoped: evaluateTagScopedStage({ captures, sources, stage, criteria,
        tagArtifacts, statusConflicts }) };
    }
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
    if (errors.length) {
      const raw = { key: stage.key, result: "error", errors, candidates };
      if (!tagArtifacts) return raw;
      return { ...raw, tagScoped: evaluateTagScopedStage({ captures, sources, stage, criteria,
        tagArtifacts, statusConflicts }) };
    }
    if (!candidates.length) {
      const raw = { key: stage.key, result: "no-proof", reason: "no-capture-roi-candidate" };
      if (!tagArtifacts) return raw;
      return { ...raw, tagScoped: evaluateTagScopedStage({ captures, sources, stage, criteria,
        tagArtifacts, statusConflicts }) };
    }
    const failed = candidates.find((candidate) => candidate.glyphs.some((glyph) => glyph.result !== "measured"));
    const raw = { key: stage.key, result: failed ? "failed" : "measured", candidates };
    if (!tagArtifacts) return raw;
    return { ...raw, tagScoped: evaluateTagScopedStage({ captures, sources, stage, criteria,
      tagArtifacts, statusConflicts }) };
  });
}

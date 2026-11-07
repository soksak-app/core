import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { attachImeFrameIdentities, captureFromCallback, readImeFrameIdentities, readRetainedSources } from "./activation/ime-visual-capture.mjs";
import { classifyCaptureCallbacks } from "./capture-callbacks.mjs";
import { verifyTerminalReference } from "./terminal-reference-content.mjs";

const key = (frame) => frame && [frame.generation, frame.raster, frame.sequence].map(String).join("/");
function one(values, label) {
  assert.equal(values.length, 1, `reference ${label} join must have exactly one result`);
  return values[0];
}
function colorSpace(value) {
  assert.ok(["sRGB", "kCGColorSpaceSRGB"].includes(value), "reference artifact color space is unsupported");
  return "sRGB";
}

/** Acquires only the later reference. Every proof-bearing DTO comes from its
 * atomic observation, retained bytes, native placement, or decoded recording. */
export function acquireTerminalReference({ evidence, captureDirectory, identityManifest, decodedRows, callbacks, expected, criteria }) {
  const observed = evidence?.observed;
  assert.ok(observed?.render && observed.cursor && observed.frame, "reference atomic observe renderer metadata is missing");
  assert.ok(Number.isSafeInteger(observed.requestId) && observed.requestId > 0, "reference observe request ownership is missing");
  assert.equal(observed.rowCount, observed.render.grid.rows, "reference observed row dimension differs");
  assert.equal(observed.columnCount, observed.render.grid.cols, "reference observed column dimension differs");
  assert.equal(observed.rows?.length, observed.rowCount, "reference observed screen row dimension differs");
  // A replay declares its own recording directory in the stop DTO. The original
  // acquisition paths remain provenance; never silently substitute those paths.
  const identities = readImeFrameIdentities(captureDirectory, evidence.capture);
  assert.deepEqual(identityManifest, JSON.parse(readFileSync(join(captureDirectory, "frame-identities", "manifest.json"), "utf8")),
    "reference identity manifest input differs from its recording");
  const recordedRows = readFileSync(join(captureDirectory, "frame-identities", "decoded-frames.jsonl"), "utf8")
    .trimEnd().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(decodedRows, recordedRows, "reference decoded identity input differs from its recording");
  const framePaths = frames(captureDirectory);
  assert.equal(evidence.capture.count, framePaths.length, "reference capture count differs from retained frame files");
  const recordedCallbacks = readFileSync(evidence.capture.callbackStatus, "utf8")
    .trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(callbacks, recordedCallbacks, "reference callback input differs from its complete raw recording trace");
  const { complete } = classifyCaptureCallbacks(callbacks, framePaths);
  attachImeFrameIdentities(complete.map(callback => ({ callback })), framePaths, identities);
  const regionObservations = decodedRows.map(row => JSON.stringify([row.frame, row.region]));
  assert.equal(new Set(regionObservations).size, regionObservations.length,
    "reference decoded identity frame and region join is ambiguous");
  const surface = evidence.terminal?.surface;
  const native = one(evidence.host.regions.filter(region => region.surface === surface && region.name === "view"), "native region");
  assert.equal(key(native.presented), key(observed.frame), "reference native presented frame differs from observe");
  assert.ok(native.visible && native.drawing && native.error === null, "reference native region is not drawing");
  const rectPt = { ...native.frame, x: evidence.host.frame.x + native.frame.x,
    y: evidence.host.frame.y + native.frame.y };
  const retained = readRetainedSources(captureDirectory, new Map([[key(observed.frame),
    { frame: observed.frame, render: observed.render }]]));
  const source = one(retained.sources.filter(source => key(source.frame) === key(observed.frame)), "retained source frame");
  const sourceManifest = JSON.parse(readFileSync(join(captureDirectory, "sources", "manifest.json"), "utf8"));
  const sourceArtifact = one(sourceManifest.artifacts.filter(artifact => key(artifact) === key(observed.frame)), "retained source artifact");
  assert.deepEqual(source.raster.screenBounds, rectPt, "reference native global placement differs from retained source");
  const issued = one(identities.artifactRecords.filter(artifact => key(artifact) === key(observed.frame)), "issued artifact");
  const matched = decodedRows.filter(row => row.status === "matched" && row.reason === null &&
    row.region === issued.regionToken && key(row.identity) === key(observed.frame));
  assert.ok(matched.length > 0, "reference decoded identity has no matched region and frame");
  const cursorShapes = { Block: "block", Beam: "beam", Underline: "underline", HollowBlock: "hollowBlock", Hidden: "hidden" };
  assert.ok(Object.hasOwn(cursorShapes, observed.cursor.shape), "reference observe cursor shape is unsupported");
  const cursor = { ...observed.cursor, frame: observed.frame, render: observed.render,
    shape: cursorShapes[observed.cursor.shape],
    preedit: observed.cursor.preedit?.text ?? observed.cursor.preedit };
  const region = { surface, name: "view", regionToken: issued.regionToken, rectPt, clipRectPt: { ...rectPt } };
  const base = { observationRequestId: observed.requestId, sourceArtifact, plugin: evidence.terminal.plugin, surface, name: "view", regionToken: issued.regionToken,
    screen: { frame: observed.frame, rows: observed.rows }, cursor,
    source: { ...source, regionToken: issued.regionToken }, region,
    issuedArtifact: { ...issued, colorSpace: colorSpace(issued.colorSpace) }, expected, criteria };
  let reference;
  for (const identityRow of matched) {
    const file = `frame-${String(identityRow.frame).padStart(4, "0")}.bgra`;
    const callback = one(complete.filter(row => row.frame === file), "callback frame");
    assert.equal(callback.status, 0, "reference callback frame is incomplete");
    assert.equal(String(callback.displayTime), String(identityRow.displayTime), "reference callback display time differs from decoded identity");
    const capture = captureFromCallback(readFrame(join(captureDirectory, file)), callback);
    const candidate = { ...base, capture, identityRow };
    // Verify every matched frame, rather than selecting one that hides a bad
    // association, compositor difference, or inconsistent QR placement.
    verifyTerminalReference(candidate);
    reference ??= candidate;
  }
  return { ...reference, proof: "verified-terminal-reference-acquisition" };
}


/** Records a later reference through the public one-shot API. Call only after
 * measured recordings and footprint intervals have ended. */
export async function captureTerminalReference(t, session, { plugin, surface, expected, criteria }) {
  assert.ok(["terminal", "term"].includes(plugin), "reference plugin must be terminal or term");
  assert.ok(typeof surface === "string" && surface, "reference surface ownership is missing");
  const recording = await session.record({ frameIdentity: true });
  let stopAttempted = false;
  session.cleanup(async () => {
    if (!stopAttempted) {
      stopAttempted = true;
      await recording.stop({ after: 0 });
    }
  });
  try {
    const observed = await session.run(`${plugin}.screen.observe`, {}, surface);
    assert.ok(observed?.frame, "reference one-shot observation has no frame");
    const host = await session.until("host.window", value => value.regions?.some(region =>
      region.surface === surface && region.name === "view" && region.visible && region.drawing &&
      region.error === null && key(region.presented) === key(observed.frame)),
    "the exact observed terminal reference image was not presented");
    const { displayed } = await session.presented();
    stopAttempted = true;
    const capture = await recording.stop({ after: displayed });
    assert.equal(capture.limited, false, "reference recording reached its bounded frame limit");
    const readJson = path => JSON.parse(readFileSync(path, "utf8"));
    const readRows = path => readFileSync(path, "utf8").trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line));
    return acquireTerminalReference({
      evidence: { terminal: { plugin, surface }, observed, host, capture },
      captureDirectory: capture.frames,
      identityManifest: readJson(join(capture.frames, "frame-identities", "manifest.json")),
      decodedRows: readRows(join(capture.frames, "frame-identities", "decoded-frames.jsonl")),
      callbacks: readRows(join(capture.frames, "callback-status.jsonl")),
      expected, criteria,
    });
  } catch (error) {
    t.diagnostic(`terminal reference acquisition failed; recording retained at ${recording.frames ?? "the session-owned capture directory"}`);
    throw error;
  }
}

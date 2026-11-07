import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { attachImeFrameIdentities, captureFromCallback, readImeFrameIdentities, readRetainedSources } from "./activation/ime-visual-capture.mjs";
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
  attachImeFrameIdentities(callbacks.map(callback => ({ callback })), framePaths, identities);
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
  const base = { plugin: evidence.terminal.plugin, surface, name: "view", regionToken: issued.regionToken,
    screen: { frame: observed.frame, rows: observed.rows }, cursor,
    source: { ...source, regionToken: issued.regionToken }, region,
    issuedArtifact: { ...issued, colorSpace: colorSpace(issued.colorSpace) }, expected, criteria };
  let reference;
  for (const identityRow of matched) {
    const file = `frame-${String(identityRow.frame).padStart(4, "0")}.bgra`;
    const callback = one(callbacks.filter(row => row.frame === file), "callback frame");
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

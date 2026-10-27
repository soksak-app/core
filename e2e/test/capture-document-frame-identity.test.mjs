import assert from "node:assert/strict";
import test from "node:test";

import { verifyDocumentFrameIdentityCapture, viewGenerationForSurface } from "../document-frame-identity.mjs";

const join = (phase, { surface = "surface-a", generation = 7, ticket = 12, joined } = {}) => ({
  layer: "host",
  event: "view.presentation-join",
  surface,
  phase,
  generation,
  ticket,
  ...(joined === undefined ? {} : { joined }),
});

test("view identity generation comes from one successful current-surface presentation join", { timeout: 1000 }, () => {
  assert.equal(viewGenerationForSurface([
    join("requested"), join("result", { joined: true }),
    join("requested", { surface: "other", generation: 99, ticket: 1 }),
  ], "surface-a"), 7);
});

test("view identity generation rejects missing, failed, or conflicting join evidence", { timeout: 1000 }, () => {
  assert.throws(() => viewGenerationForSurface([join("requested")], "surface-a"), /successful presentation join/);
  assert.throws(() => viewGenerationForSurface([
    join("requested"), join("result", { joined: false }),
  ], "surface-a"), /successful presentation join/);
  assert.throws(() => viewGenerationForSurface([
    join("requested"), join("result", { joined: true }),
    join("requested", { generation: 8, ticket: 13 }), join("result", { generation: 8, ticket: 13, joined: true }),
  ], "surface-a"), /one current view generation/);
  assert.throws(() => viewGenerationForSurface([
    join("requested", { generation: 0 }), join("result", { generation: 0, joined: true }),
  ], "surface-a"), /positive safe integer generation/);
  assert.equal(viewGenerationForSurface([
    join("requested"), join("result", { joined: true }), join("requested", { ticket: 13 }),
  ], "surface-a"), 7, "an unrelated pending join does not invalidate a successful current-generation join");
});

const documentCapture = () => {
  const start = {
    surface: "surface-a", generation: 7, atlasSlots: 512,
    roi: { x: 10, y: 20, width: 800, height: 600, scale: 2 },
  };
  const generatedIdentities = Array.from({ length: 512 }, (_, index) => {
    const sequence = index + 1;
    return {
    generation: "7", raster: "18446744073709551615", sequence, payload: `payload-${sequence}`,
    };
  });
  const manifest = {
    format: 1,
    decodedFramesFile: "decoded-frames.jsonl",
    documentFrameIdentity: {
      generation: "7", raster: "18446744073709551615", regionToken: "00112233445566778899aabbccddeeff",
      screenROI: { x: 10, y: 20, width: 800, height: 600 }, atlasFile: "document-atlas.png",
      atlasSlots: 512, issuedSlots: 2, generatedIdentities, decodedRecords: 2, matchedRecords: 1,
      unknownRecords: 1, incompleteSamples: 0,
    },
  };
  const decodedRows = [
    { frame: 1, displayTime: "9001", region: manifest.documentFrameIdentity.regionToken,
      roi: { x: 100, y: 200, width: 64, height: 64 }, status: "matched",
      identity: { generation: "7", raster: "18446744073709551615", sequence: 2 }, reason: null,
      sourceKind: "document", decodeEnqueuedTime: "8001", decodeStartTime: "8002", decodeCompleteTime: "8003" },
    { frame: 2, displayTime: "9002", region: manifest.documentFrameIdentity.regionToken,
      roi: null, status: "unknown", identity: null, reason: "no-code", sourceKind: "document",
      decodeEnqueuedTime: "8004", decodeStartTime: null, decodeCompleteTime: null },
  ];
  return { start, stop: { frameIdentity: { status: "complete", issuedSlots: 2, manifest: "/capture/frame-identities/manifest.json" } },
    manifest, decodedRows, surface: "surface-a", generation: 7 };
};

test("document identity capture validates complete accounting and a decoded issued pixel identity", { timeout: 1000 }, () => {
  const capture = documentCapture();
  assert.deepEqual(verifyDocumentFrameIdentityCapture(capture), {
    generation: 7, issuedSlots: 2, decodedRecords: 2, matchedRecords: 1, unknownRecords: 1,
    matchedFrames: [1], manifest: "/capture/frame-identities/manifest.json",
  });
});

test("document identity capture rejects missing accounting and unissued decoded identities", { timeout: 1000 }, () => {
  const missingStopCount = documentCapture();
  delete missingStopCount.stop.frameIdentity.issuedSlots;
  assert.throws(() => verifyDocumentFrameIdentityCapture(missingStopCount), /issuedSlots/);

  const countMismatch = documentCapture();
  countMismatch.manifest.documentFrameIdentity.matchedRecords = 2;
  assert.throws(() => verifyDocumentFrameIdentityCapture(countMismatch), /matchedRecords/);

  const unissued = documentCapture();
  unissued.decodedRows[0].identity.sequence = 9;
  assert.throws(() => verifyDocumentFrameIdentityCapture(unissued), /issued document identity/);

  const noPixelMatch = documentCapture();
  noPixelMatch.decodedRows[0].status = "unknown";
  noPixelMatch.decodedRows[0].identity = null;
  noPixelMatch.decodedRows[0].reason = "no-code";
  noPixelMatch.manifest.documentFrameIdentity.matchedRecords = 0;
  noPixelMatch.manifest.documentFrameIdentity.unknownRecords = 2;
  assert.throws(() => verifyDocumentFrameIdentityCapture(noPixelMatch), /no decoded document identity/);
});

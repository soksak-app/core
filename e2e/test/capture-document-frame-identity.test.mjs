import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import test, { after } from "node:test";

import { writeStillRecording } from "@soksak/window-check/still-recording.mjs";

import { documentIdentityCardIds, verifyDocumentFrameIdentityCapture, viewGenerationForSurface } from "../document-frame-identity.mjs";

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

test("document identity setup adds its root view tab only to editable pane cards", { timeout: 1000 }, () => {
  const observedGrid = {
    cards: [
      { id: "left", fixed: true, pane: null, tabs: [], active: null },
      { id: "card-a", fixed: false, pane: 0, tabs: [{ id: "tab-a", plugin: "layoutprobe" }], active: "tab-a" },
    ],
  };
  assert.deepEqual(documentIdentityCardIds(observedGrid), ["card-a"]);
  assert.throws(() => documentIdentityCardIds({ cards: [{ id: "left", fixed: true, pane: null, tabs: [] }] }),
    /no editable pane card/);
});

// The still recording of the capture: stills 0 to 2 every 8ms, each completed 0.5ms after its request, on a timebase of
// nanoseconds.
const stillsDirectory = mkdtempSync(joinPath(tmpdir(), "document-identity-stills-"));
after(() => rmSync(stillsDirectory, { recursive: true, force: true }));
const { stills } = writeStillRecording(stillsDirectory, { gap: 8, until: 16 });

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
    { index: 1, requested: "8000000", completed: "8500000", region: manifest.documentFrameIdentity.regionToken,
      roi: { x: 100, y: 200, width: 64, height: 64 }, status: "matched",
      identity: { generation: "7", raster: "18446744073709551615", sequence: 2 }, reason: null,
      sourceKind: "document", decodeEnqueuedTime: "8001", decodeStartTime: "8002", decodeCompleteTime: "8003" },
    { index: 2, requested: "16000000", completed: "16500000", region: manifest.documentFrameIdentity.regionToken,
      roi: null, status: "unknown", identity: null, reason: "no-code", sourceKind: "document",
      decodeEnqueuedTime: "8004", decodeStartTime: null, decodeCompleteTime: null },
  ];
  return { start, stop: { stills, frameIdentity: { status: "complete", issuedSlots: 2,
    manifest: "/capture/frame-identities/manifest.json" } },
    manifest, decodedRows, surface: "surface-a", generation: 7 };
};

test("document identity capture validates complete accounting and a decoded issued pixel identity", { timeout: 1000 }, () => {
  const capture = documentCapture();
  assert.deepEqual(verifyDocumentFrameIdentityCapture(capture), {
    generation: 7, issuedSlots: 2, decodedRecords: 2, matchedRecords: 1, unknownRecords: 1,
    matchedStills: [1], manifest: "/capture/frame-identities/manifest.json",
  });
});

// A decoded row names the still whose pixels it decoded, by its index and its request and completion ticks in stills.jsonl, and
// the document region is one region of each still.
test("document identity capture rejects a decoded row of no still of the recording and a still decoded twice", { timeout: 1000 }, () => {
  const otherTime = documentCapture();
  otherTime.decodedRows[0].completed = "8500001";
  assert.throws(() => verifyDocumentFrameIdentityCapture(otherTime), new RegExp("^Error: document identity: decoded row 0 names " +
    "still 1 requested at 8000000 and completed at 8500001, and .*stills\\.jsonl has it requested at 8000000 and completed at 8500000$"));

  const unplanned = documentCapture();
  unplanned.decodedRows[1].index = 3;
  assert.throws(() => verifyDocumentFrameIdentityCapture(unplanned),
    /^Error: document identity: decoded row 1 names still 3, which .*stills\.jsonl does not plan$/);

  const twice = documentCapture();
  Object.assign(twice.decodedRows[1], { index: 1, requested: "8000000", completed: "8500000" });
  assert.throws(() => verifyDocumentFrameIdentityCapture(twice), /^Error: document identity decoded rows name still 1 twice$/);
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

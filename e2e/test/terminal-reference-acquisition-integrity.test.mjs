import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadTerminalReferenceFixture } from "./terminal-reference-fixture.mjs";
import { acquireTerminalReference } from "../terminal-reference-acquisition.mjs";

// Mutations belong only to each test's extracted recording. Keep wire DTOs and
// their owning files consistent so canonical recording validators see defects.
function persist(input) {
  writeFileSync(join(input.captureDirectory, "frame-identities", "manifest.json"), JSON.stringify(input.identityManifest));
  writeFileSync(join(input.captureDirectory, "frame-identities", "decoded-frames.jsonl"),
    input.decodedRows.map(row => JSON.stringify(row)).join("\n") + "\n");
}

test("reference acquisition permits distinct region decoder rows for one actual frame", t => {
  const input = loadTerminalReferenceFixture(t);
  const target = input.decodedRows.find(row => row.status === "matched");
  assert.ok(target);
  input.decodedRows.push({ ...structuredClone(target), region: "another-observed-region", status: "unknown",
    reason: "no-code", identity: null });
  input.identityManifest.decodedRecords += 1;
  persist(input);
  assert.equal(acquireTerminalReference(input).proof, "verified-terminal-reference-acquisition");
});

test("reference acquisition normalizes the HollowBlock wire enum to hollowBlock", t => {
  const input = loadTerminalReferenceFixture(t);
  // The cursor lies outside every selected prompt/guard cell; this exercises
  // enum normalization without changing any compared pixels or ink evidence.
  input.evidence.observed.cursor.shape = "HollowBlock";
  input.evidence.observed.render.cursor.shape = "hollowBlock";
  assert.equal(acquireTerminalReference(input).cursor.shape, "hollowBlock");
});

const invalid = [
  ["cleanup failure", x => { x.identityManifest.cleanupFailures = 1; }],
  ["cleanup error details", x => { x.identityManifest.cleanupErrors = ["failed artifact cleanup"]; }],
  ["omitted cleanup errors", x => { x.identityManifest.cleanupErrorsOmitted = 1; }],
  ["decoded write failure", x => { x.identityManifest.decodedWriteFailures = 1; }],
  ["decoder session failure", x => { x.identityManifest.identityFailure = "decoder failed"; }],
  ["decoded record count mismatch", x => { x.identityManifest.decodedRecords += 1; }],
  ["decoded frame count mismatch", x => { x.identityManifest.decodedFrames += 1; }],
  ["issued artifact byte total mismatch", x => { x.identityManifest.artifactBytes += 1; }],
  ["incomplete identity stop result", x => { x.evidence.capture.frameIdentity.status = "incomplete"; }],
  ["identity stop manifest path mismatch", x => { x.evidence.capture.frameIdentity.manifest += ".wrong"; }],
  ["missing callback coverage for a retained capture", x => { x.callbacks.pop(); }],
  ["missing decoder coverage for a retained capture", x => {
    const frame = x.decodedRows.at(-1).frame;
    x.decodedRows = x.decodedRows.filter(row => row.frame !== frame);
    x.identityManifest.decodedRecords = x.decodedRows.length;
    x.identityManifest.decodedFrames = new Set(x.decodedRows.map(row => row.frame)).size;
  }],
  ["duplicate same-frame same-region decoder observation", x => {
    x.decodedRows.push(structuredClone(x.decodedRows[0]));
    x.identityManifest.decodedRecords += 1;
  }],
];
for (const [name, mutate] of invalid) {
  test(`reference acquisition refuses ${name}`, t => {
    const input = loadTerminalReferenceFixture(t);
    mutate(input);
    persist(input);
    assert.throws(() => acquireTerminalReference(input), error => error.code === "ERR_ASSERTION" &&
      /cleanup|decoded|decoder|identity|artifact|manifest|capture|callback|region|frame|record|byte/i.test(error.message));
  });
}

// The native raw trace retains idle callbacks even though they have no frame.
// These two rows are copied from the actual failing Wails reference recording;
// only sequence is rebased to insert them into this independent replay trace.
const rawIdleCallbacks = JSON.parse(readFileSync(new URL("./fixtures/capture-idle-callbacks.json", import.meta.url), "utf8"));
function addIdleCallbacks(input) {
  for (const raw of rawIdleCallbacks) input.callbacks.push({ ...raw, sequence: input.callbacks.length + 1 });
  writeFileSync(join(input.captureDirectory, "callback-status.jsonl"), input.callbacks.map(row => JSON.stringify(row)).join("\n") + "\n");
}

test("reference acquisition retains actual idle callbacks while joining every complete frame", t => {
  const input = loadTerminalReferenceFixture(t);
  addIdleCallbacks(input);
  const before = structuredClone(input.callbacks);
  assert.equal(acquireTerminalReference(input).proof, "verified-terminal-reference-acquisition");
  assert.deepEqual(input.callbacks, before, "classification must not remove or rewrite raw callbacks");
});

for (const [name, change] of [
  ["unknown noncomplete status", row => { row.status = 6; }],
  ["missing status", row => { row.status = null; }],
  ["noncomplete callback claiming a frame", (row, input) => { row.frame = input.callbacks[0].frame; }],
  ["complete callback without a retained frame", row => { row.status = 0; }],
  ["callback sequence gap", row => { row.sequence++; }],
]) test(`reference acquisition rejects ${name} in the raw callback trace`, t => {
  const input = loadTerminalReferenceFixture(t);
  addIdleCallbacks(input);
  change(input.callbacks.at(-1), input);
  writeFileSync(join(input.captureDirectory, "callback-status.jsonl"), input.callbacks.map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.throws(() => acquireTerminalReference(input), /callback|status|sequence|frame/i);
});

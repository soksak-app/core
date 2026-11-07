import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { readFrame } from "@soksak/window-check/frame.mjs";
import { classifyCaptureCallbacks } from "./capture-callbacks.mjs";
import { captureFromCallback } from "./activation/ime-visual-capture.mjs";
import { captureTerminalReference } from "./terminal-reference-acquisition.mjs";
import { firstTerminalReferenceStartFrame, createTerminalReferenceProof } from "./terminal-reference-content.mjs";
import { measureViewCardFrameGeometry } from "./view-frame-geometry.mjs";

/** Restores the existing public normal callback geometry, without adding later
 * surface IDs, frame identities or placement snapshots to earlier frames. */
export function readTerminalRecordedFrames(capture, paths, decoded = paths.map(readFrame)) {
  assert.equal(capture.limited, false, "terminal normal recording reached its bounded frame limit");
  assert.equal(paths.length, capture.count, "terminal normal recording frame coverage differs");
  assert.equal(decoded.length, paths.length, "terminal decoded normal recording coverage differs");
  const callbacks = readFileSync(capture.callbackStatus, "utf8").trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const { complete } = classifyCaptureCallbacks(callbacks, paths);
  return decoded.map((frame, index) => {
    assert.equal(frame.contentScale, 1, "terminal exact reference comparison requires original-resolution normal captures");
    const rows = complete.filter(row => row.frame === basename(paths[index]));
    assert.equal(rows.length, 1, "terminal normal callback association is missing or ambiguous");
    assert.equal(rows[0].status, 0, "terminal normal callback frame is incomplete");
    return { capture: captureFromCallback(frame, rows[0]) };
  });
}

/** Called by the real deferred verifier only after the process/footprint and
 * normal capture intervals have ended. The reference may select an older tab. */
export async function verifyTerminalRecordedContent(t, session, { plugin, surface, card,
  expectedContent, capture, paths, anchor, targetRequestAtMs }) {
  assert.ok(plugin === "terminal" || plugin === "term", "recorded terminal plugin is unsupported");
  assert.ok(anchor?.slotPlan?.card === card, "normal recording has no pre-request declared card/slot plan");
  const decoded = paths.map(readFrame);
  const frames = readTerminalRecordedFrames(capture, paths, decoded);
  const geometryFrames = decoded.map(frame => measureViewCardFrameGeometry(frame, {
    ...anchor.slotPlan.geometry, targetRect: anchor.slotPlan.cardRect,
  }));
  // Selection and one-shot reference drawing are outside every measured interval.
  await session.run("core.tab.select", { tab: surface });
  await session.until("core.grid", value => value.cards?.some(item => item.id === card && item.active === surface),
    "the measured terminal tab was not selected for its later reference");
  const reference = await captureTerminalReference(t, session, { plugin, surface,
    expected: { text: expectedContent, row: 0, startColumn: 0,
      guards: [{ row: 0, edge: "left", column: 0 }, { row: 0, column: expectedContent.length }] },
    criteria: { colorDistance: 32, minimumGlyphPixels: 1, minimumUnderlineCoverage: 0.75 } });
  const proof = firstTerminalReferenceStartFrame({ reference, target: { card, surface }, frames, geometryFrames,
    anchorPresentedAtMs: anchor.displayed, targetRequestAtMs, slotInsetsPt: anchor.slotPlan.slotInsetsPt,
    anchorNativeRectPt: anchor.slotPlan.nativeRectPt });
  const anchorContentFrame = { frameIndex: proof.anchorFrameIndex, frameCount: decoded.length,
    timeMs: decoded[proof.anchorFrameIndex].time,
    proof: { targetAbsent: expectedContent, method: "verified-terminal-reference-exact-pixels" } };
  const metricFrame = { surface, frameIndex: proof.frameIndex, frameCount: decoded.length,
    timeMs: decoded[proof.frameIndex].time };
  const contentFrame = { ...metricFrame,
    proof: { ...createTerminalReferenceProof(reference, frames[proof.frameIndex].capture, proof.matchedRectPt, metricFrame),
      slotProjection: proof.slotProjection } };
  return { anchor: { ...anchor, contentFrame: anchorContentFrame }, contentFrame,
    recording: { directory: capture.frames, frameCount: paths.length, files: paths, anchorContentFrame } };
}

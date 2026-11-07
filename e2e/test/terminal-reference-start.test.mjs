import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as content from "../terminal-reference-content.mjs";
import { acquireTerminalReference } from "../terminal-reference-acquisition.mjs";
import { loadTerminalReferenceFixture } from "./terminal-reference-fixture.mjs";

const options = { timeout: 10000 };
for (const plugin of ["terminal", "term"]) {
  test(`${plugin} startup rejects old correct pixels before its physical anchor and selects earliest exact new content without inherited frame IDs`, options, t => {
    const input = loadTerminalReferenceFixture(t, `${plugin}-positive`);
    const reference = acquireTerminalReference(input);
    const r = reference.region.rectPt;
    const x = r.x - reference.capture.screenRect.x;
    const y = r.y - reference.capture.screenRect.y;
    const rect = { left: x, top: y, right: x + r.width, bottom: y + r.height };
    const frames = [
      { capture: reference.capture },
      { capture: { ...reference.capture, data: new Uint8Array(reference.capture.data.length).fill(255) } },
      { capture: reference.capture },
      { capture: reference.capture },
    ];
    const geometryFrames = frames.map((_, index) => ({ timeMs: index + 1, cardRectPt: { ...rect } }));
    const target = { card: "declared-before-open", surface: input.evidence.terminal.surface };
    const value = { reference, target, frames, geometryFrames, anchorPresentedAtMs: 1.5, targetRequestAtMs: 2.5,
      anchorNativeRectPt: { x, y, width: r.width, height: r.height },
      slotInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 } };
    assert.equal(typeof content.firstTerminalReferenceStartFrame, "function", "actual startup needs an exact different-content boundary, not OCR");
    const proof = content.firstTerminalReferenceStartFrame(value);
    assert.equal(proof.anchorFrameIndex, 1);
    assert.equal(proof.frameIndex, 2);
    assert.equal(proof.proof, "verified-terminal-reference-start-exact-pixels");
    for (const frame of frames) assert.deepEqual(Object.keys(frame), ["capture"], "normal frames acquire no later surface, token or tuple");
    const missing = structuredClone(value);
    delete missing.geometryFrames[1].cardRectPt;
    assert.throws(() => content.firstTerminalReferenceStartFrame(missing), /geometry|measured|rectangle/);
    const wrongDimensions = structuredClone(value);
    wrongDimensions.geometryFrames[1].cardRectPt.right -= 1;
    assert.throws(() => content.firstTerminalReferenceStartFrame(wrongDimensions), /width|dimension|geometry/);
    assert.throws(() => content.firstTerminalReferenceStartFrame({ ...value, targetRequestAtMs: 1.6 }), /anchor/,
      "target loading after the open request cannot masquerade as the preceding anchor");
    const noAnchor = { ...value, frames: frames.map(() => ({ capture: reference.capture })) };
    assert.throws(() => content.firstTerminalReferenceStartFrame(noAnchor), /anchor/);
    const staleOwner = { ...value, target: { ...target, surface: "another-surface" } };
    assert.throws(() => content.firstTerminalReferenceStartFrame(staleOwner), /target|surface/);
  });
}

test("actual terminal startup/reopen/reclaim consumer dispatches strict proof while other plugins retain their declared path", options, () => {
  const source = readFileSync(new URL("../view-metrics-collection.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export async function openRecordedView("), source.indexOf("function validateFootprintSample("));
  assert.ok(body.includes("verifyTerminalRecordedContent("), "the actual shared consumer must route both terminal plugins to strict recorded reference proof");
  assert.ok(body.includes('plugin === "terminal"') && body.includes('plugin === "term"'), "neither terminal backend can retain an OCR fallback");
  assert.ok(source.includes("verifyOpenedViewContent(view)"), "process-group collector must retain its deferred verification after footprints");
});

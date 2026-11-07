import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as content from "../terminal-reference-content.mjs";
import { acquireTerminalReference } from "../terminal-reference-acquisition.mjs";
import { loadTerminalReferenceFixture } from "./terminal-reference-fixture.mjs";

for (const plugin of ["terminal", "term"]) {
  test(`${plugin} metric proof binds actual observed glyph text and source/capture bytes to their reference ownership`, { timeout: 10000 }, t => {
    const input = loadTerminalReferenceFixture(t, `${plugin}-positive`);
    const reference = acquireTerminalReference(input);
    assert.equal(typeof content.createTerminalReferenceProof, "function", "actual metric producers need a strict reference proof object");
    const proof = content.createTerminalReferenceProof(reference, reference.capture, reference.region.rectPt,
      { surface: input.evidence.terminal.surface, frameIndex: 2, frameCount: 4, timeMs: 20 });
    assert.equal(proof.method, "terminal-reference-exact-pixels-v1");
    assert.equal(proof.observedText, "sh-3.2$");
    assert.equal(proof.observedTextSha256, createHash("sha256").update(proof.observedText).digest("hex"));
    assert.equal(proof.reference.sourceSha256, createHash("sha256").update(reference.source.raster.data).digest("hex"));
    assert.equal(proof.reference.sourceSha256, proof.reference.retainedSourceSha256);
    assert.equal(proof.reference.observationRequestId, input.evidence.observed.requestId);
    assert.deepEqual(proof.reference.frame, input.evidence.observed.frame);
    assert.equal(proof.match.sourceCellsSha256, proof.match.capturedCellsSha256);
    assert.deepEqual([proof.match.frameIndex, proof.match.frameCount, proof.match.timeMs], [2, 4, 20]);
    assert.equal(proof.match.cellCount, 8);
    assert.ok(proof.match.byteCount > 0);
    const corrupted = { ...reference.capture, data: new Uint8Array(reference.capture.data.length).fill(255) };
    assert.throws(() => content.createTerminalReferenceProof(reference, corrupted, reference.region.rectPt,
      { surface: input.evidence.terminal.surface, frameIndex: 2, frameCount: 4, timeMs: 20 }), /pixels|crop|capture|reference/);
    const missing = { ...reference, observationRequestId: undefined };
    assert.throws(() => content.createTerminalReferenceProof(missing, reference.capture, reference.region.rectPt,
      { surface: input.evidence.terminal.surface, frameIndex: 2, frameCount: 4, timeMs: 20 }), /observation|ownership/);
  });
}

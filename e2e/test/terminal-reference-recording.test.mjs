import assert from "node:assert/strict";
import test from "node:test";
import * as acquisition from "../terminal-reference-acquisition.mjs";
import { loadTerminalReferenceFixture } from "./terminal-reference-fixture.mjs";

const options = { timeout: 10000 };
for (const plugin of ["terminal", "term"]) {
  test(`${plugin} reference recording observes only after the measured recording and stops after its exact image is presented`, options, async t => {
    const fixture = loadTerminalReferenceFixture(t, `${plugin}-positive`);
    const { evidence } = fixture;
    const calls = ["measured recording stopped", "footprint interval ended"];
    const cleanups = [];
    const session = {
      cleanup(fn) { cleanups.push(fn); },
      async record(params) {
        calls.push("reference recording started");
        assert.deepEqual(params, { frameIdentity: true });
        return { async stop(params) {
          calls.push("reference recording stopped");
          assert.deepEqual(params, { after: 42 });
          return evidence.capture;
        } };
      },
      async run(name, params, surface) {
        calls.push("atomic screen.observe");
        assert.equal(name, `${plugin}.screen.observe`);
        assert.deepEqual(params, {});
        assert.equal(surface, evidence.terminal.surface);
        return evidence.observed;
      },
      async until(name, predicate) {
        calls.push("exact native presentation");
        assert.equal(name, "host.window");
        const stale = structuredClone(evidence.host);
        stale.regions.find(row => row.surface === evidence.terminal.surface && row.name === "view").presented.sequence += 1;
        assert.equal(predicate(stale), false, "another sequence cannot establish reference presentation");
        assert.equal(predicate(evidence.host), true);
        return evidence.host;
      },
      async presented() { calls.push("reference displayed"); return { displayed: 42 }; },
    };
    assert.equal(typeof acquisition.captureTerminalReference, "function", "live reference acquisition must use the public one-shot observation");
    const reference = await acquisition.captureTerminalReference(t, session, {
      plugin, surface: evidence.terminal.surface, expected: fixture.expected, criteria: fixture.criteria,
    });
    assert.equal(reference.proof, "verified-terminal-reference-acquisition");
    assert.deepEqual(reference.screen.frame, evidence.observed.frame);
    assert.deepEqual(calls, ["measured recording stopped", "footprint interval ended", "reference recording started",
      "atomic screen.observe", "exact native presentation", "reference displayed", "reference recording stopped"]);
    for (const cleanup of cleanups.reverse()) await cleanup();
    assert.equal(calls.filter(call => call === "reference recording stopped").length, 1, "recording ownership must stop exactly once");
  });
}

for (const plugin of ["terminal", "term"]) {
  test(`${plugin} layout retains its same-content old-width anchor and selects the earliest exact changed-slot reference pixels`, options, async t => {
    const fixture = loadTerminalReferenceFixture(t, `${plugin}-positive`);
    const reference = acquisition.acquireTerminalReference(fixture);
    const { firstTerminalReferenceLayoutFrame } = await import("../terminal-reference-content.mjs");
    assert.equal(typeof firstTerminalReferenceLayoutFrame, "function", "layout requires a geometry anchor, not a fabricated different-content anchor");
    const r = reference.region.rectPt;
    const localX = r.x - reference.capture.screenRect.x;
    const localY = r.y - reference.capture.screenRect.y;
    // The baseline deliberately retains the exact SAME prompt pixels. Its
    // independently supplied measured slot is narrower; content absence must
    // never be manufactured to satisfy the different-content-anchor helper.
    const frames = [
      { capture: reference.capture },
      { capture: { ...reference.capture, data: new Uint8Array(reference.capture.data.length).fill(255) } },
      { capture: reference.capture },
      { capture: reference.capture },
    ];
    const geometryFrames = frames.map((frame, index) => {
      const rect = { left: localX, top: localY, right: localX + r.width - (index === 0 ? 16 : 0), bottom: localY + r.height };
      return { timeMs: index + 1, nativeRectPt: rect, cardRectPt: { ...rect } };
    });
    const input = { reference, target: { card: "measured-card", surface: fixture.evidence.terminal.surface },
      frames, geometryFrames, beforeChangeTimeMs: 1.5,
      slotInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 } };
    const result = firstTerminalReferenceLayoutFrame(input);
    assert.equal(result.frameIndex, 2, "blank first changed-slot frame is rejected, earliest correct frame wins");
    assert.equal(result.geometryAnchorFrameIndex, 0);
    assert.equal(result.proof, "verified-terminal-reference-layout-exact-pixels");
    const missing = structuredClone(input);
    delete missing.geometryFrames[1].nativeRectPt;
    assert.throws(() => firstTerminalReferenceLayoutFrame(missing), /measured|geometry|rectangle/);
    const dimension = structuredClone(input);
    dimension.geometryFrames[1].nativeRectPt.right -= 1;
    dimension.geometryFrames[1].cardRectPt.right -= 1;
    assert.throws(() => firstTerminalReferenceLayoutFrame(dimension), /geometry|dimension|width|placement/);
    const mismatched = structuredClone(input);
    // structuredClone preserves shared object identity. Detach normal capture
    // bytes explicitly so this negative never corrupts the verified reference.
    for (const frame of mismatched.frames.slice(1)) {
      frame.capture = { ...frame.capture, data: new Uint8Array(frame.capture.data.length).fill(255) };
    }
    assert.throws(() => firstTerminalReferenceLayoutFrame(mismatched), /no captured|reference pixels/);
  });
}


test("reference acquisition rejects a cursor on the complete prompt guard instead of hiding a blink variant", options, async t => {
  const fixture = loadTerminalReferenceFixture(t);
  const reference = acquisition.acquireTerminalReference(fixture);
  const { verifyTerminalReference } = await import("../terminal-reference-content.mjs");
  const grid = reference.source.raster.grid;
  reference.cursor.col = 7;
  reference.source.render.cursor.rect = { x: grid.x + 7 * grid.cellWidth,
    y: grid.y, width: grid.cellWidth, height: grid.cellHeight };
  assert.throws(() => verifyTerminalReference(reference), /cursor overlaps.*glyph|cursor overlaps.*guard/,
    "cursor-bearing reference cells require independent variants; this prompt contract must fail explicitly");
});

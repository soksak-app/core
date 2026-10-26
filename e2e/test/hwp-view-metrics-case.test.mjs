import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertHwpFrameMatchesSlot, hwpDocumentHistoryEvidence, hwpFirstContentFrame, hwpGeometryPalette, hwpViewDescriptor }
  from "../benchmark/cases/hwp.mjs";
import { processStartSamples } from "../view-metrics-collection.mjs";
import { viewProcessPids } from "../view-process-footprint.mjs";

test("HWP descriptor waits for its declared document status exposure", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hwp-view-readiness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.SOKSAK_CAPTURE_TEXT;
  process.env.SOKSAK_CAPTURE_TEXT = previous ?? "not-invoked";
  const cleanups = [];
  try {
    const descriptor = await hwpViewDescriptor({
      async get(name) { assert.equal(name, "core.project"); return { root }; },
      cleanup(callback) { cleanups.push(callback); },
    });
    assert.equal(descriptor.readinessStatus, "hwp.document");
  } finally {
    for (const cleanup of cleanups) cleanup();
    if (previous === undefined) delete process.env.SOKSAK_CAPTURE_TEXT;
    else process.env.SOKSAK_CAPTURE_TEXT = previous;
  }
});

test("HWP reclaim evidence reads exact root and studio histories from the diagnostic reply", () => {
  assert.deepEqual(hwpDocumentHistoryEvidence({ historyEntries: 1, regionHistoryEntries: 1 }), {
    historyEntries: 1, regionHistoryEntries: 1,
  });
  assert.throws(() => hwpDocumentHistoryEvidence({ historyEntries: 1 }), /regionHistoryEntries/);
  assert.throws(() => hwpDocumentHistoryEvidence({ historyEntries: 1, regionHistoryEntries: 2 }), /exactly its initial entry/);
});

test("HWP process starts use the canonical shared event clock parser", () => {
  const surfaces = ["hwp-a"];
  const events = [
    { event: "host.trace.view.process-request", ts_us: 50_000_000, mono_ns: 1_000_000_000,
      fields: { plugin: "hwp", surface: "hwp-a" } },
    { event: "host.trace.view.process-ready", ts_us: 50_003_000, mono_ns: 1_003_000_000,
      fields: { plugin: "hwp", surface: "hwp-a" } },
  ];
  const [sample] = processStartSamples(events, surfaces, "hwp");
  assert.deepEqual({ requestAtMs: sample.requestAtMs, readyAtMs: sample.readyAtMs,
    requestTsUs: sample.requestTsUs, readyTsUs: sample.readyTsUs,
    requestMonoNs: sample.requestMonoNs, readyMonoNs: sample.readyMonoNs }, {
    requestAtMs: 1000, readyAtMs: 1003, requestTsUs: 50_000_000, readyTsUs: 50_003_000,
    requestMonoNs: 1_000_000_000, readyMonoNs: 1_003_000_000,
  });
});

test("HWP footprint group includes its root and attached studio document processes", () => {
  const host = { documents: [
    { surface: "hwp-a", document: "", process: 701 },
    { surface: "hwp-a", document: "studio", process: 702 },
    { surface: "other", document: "", process: 703 },
  ] };
  assert.deepEqual(viewProcessPids(host, ["hwp-a"]), [701, 702]);
});

test("HWP first-content sample requires OCR-confirmed decoded pixels in capture order", async () => {
  const recognized = [];
  const result = await hwpFirstContentFrame({
    captured: [{ time: 10 }, { time: 26 }, { time: 43 }],
    rect: { x: 0, y: 0, w: 20, h: 20 },
    directory: "/unused-with-recognizer",
    recognizeFrame: async (frame) => {
      recognized.push(frame.time);
      return { lines: frame.time === 26 ? ["속삭한글문서확인"] : ["blank"] };
    },
  });
  assert.deepEqual(recognized, [10, 26]);
  assert.deepEqual(result, {
    frameIndex: 1,
    frameCount: 3,
    timeMs: 26,
    proof: { expected: "속삭한글문서확인", actual: "속삭한글문서확인", lines: ["속삭한글문서확인"] },
  });
});

test("HWP geometry color comes from dominant opaque pixels in the actual studio rectangle", () => {
  const width = 40, height = 30, stride = width * 4;
  const data = new Uint8Array(stride * height);
  const color = [241, 242, 243];
  for (let pixel = 0; pixel < width * height; pixel++) {
    const at = pixel * 4;
    data[at] = color[2]; data[at + 1] = color[1]; data[at + 2] = color[0]; data[at + 3] = 255;
  }
  const frame = { width, height, stride, data, scale: 1, contentScale: 1,
    content: { x: 0, y: 0 }, time: 100 };
  assert.deepEqual(hwpGeometryPalette(frame, { x: 0, y: 0, width, height }, {
    card: "#191b24", bg: "#101117", edge: "#2b2e3d", focus: "#ffb36b",
  }).contentColor, color);
});

test("HWP geometry compares measured studio edges with the declared slot insets", () => {
  const geometry = {
    cardRectPt: { left: 0, top: 0, right: 100, bottom: 80 },
    nativeRectPt: { left: 8, top: 6, right: 92, bottom: 74 },
  };
  assert.equal(assertHwpFrameMatchesSlot(geometry, { left: 8, top: 6, right: 8, bottom: 6 }), 0);
  assert.throws(() => assertHwpFrameMatchesSlot({ ...geometry,
    nativeRectPt: { ...geometry.nativeRectPt, right: 88 } }, { left: 8, top: 6, right: 8, bottom: 6 }), /differs from its declared slot/);
});

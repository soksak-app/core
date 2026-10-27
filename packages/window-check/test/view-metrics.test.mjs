import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { assertViewMeasurements, runViewMeasurements } from "../view-metrics.mjs";

const options = { plugin: "fixture-view", host: "wailsv3", baselineMs: 10 };

function process(pid, footprintBytes) {
  return { pid, footprintBytes };
}

function nativePlacement(width, height, timeMs, surface = "fixture-surface") {
  const monoNs = timeMs * 1_000_000;
  const framePt = { x: 0.5, y: 1.5, width, height };
  return { surface, phase: "placed", visible: true, timeMs,
    framePt,
    webKitViewport: { width: Math.trunc(width), height: Math.trunc(height) },
    placement: { event: "host.trace.surface", seq: timeMs * 1000, ts_us: timeMs * 1000, mono_ns: monoNs,
      fields: { surface, phase: "placed", visible: true, x: framePt.x, y: framePt.y, w: width, h: height } } };
}

function contentFrame(sourceSequence, frameIndex, frameTimeMs, lowerMs, upperMs, width, nativeWidth) {
  return { sourceSequence, frameIndex, captureTimeMs: frameIndex === null ? null : Math.max(frameTimeMs, upperMs),
    displayCapture: frameIndex === null ? null : { frameIndex: Math.max(frameIndex, 6),
      timeMs: Math.max(128, frameTimeMs, upperMs) },
    frameTimeMs, timeRange: { lowerMs, upperMs }, width, height: 80,
    nativePlacement: nativePlacement(nativeWidth, 80, lowerMs - 1) };
}

function metrics() {
  return {
    plugin: "fixture-view",
    host: "wailsv3",
    total: {
      viewCount: 3,
      oneViewProcesses: [process(101, 2_000_000)],
      allViewProcesses: [process(201, 6_000_000), process(202, 5_000_000), process(203, 5_000_000)],
    },
    reclaim: [1, 2, 3].map((surface) => ({
      beforeProcesses: [process(surface, 10_000_000)],
      afterProcesses: [process(surface, 1_000_000)],
      elapsedMs: 10_000,
      engineCacheHeld: false,
      closedViews: [{ surface: `surface-${surface}`, rootHistoryEntries: 1,
        documents: [{ document: "document", historyEntries: 1 }] }],
    })),
    warmDisplay: {
      surface: "warm-surface",
      beforePids: [81],
      beforePidsAtMs: 9,
      openedPid: 81,
      requestAtMs: 10,
      contentFrame: {
        frameIndex: 2,
        frameCount: 8,
        timeMs: 320,
        proof: { expected: "fixture text", actual: "fixture text", lines: ["fixture text"] },
      },
    },
    newProcess: {
      processStarts: [10, 20, 30, 40, 50].map((duration, index) => ({
        requestAtMs: index * 100,
        readyAtMs: index * 100 + duration,
      })),
      firstDisplays: [0, 1, 2].map((index) => ({
        requestAtMs: index * 1000,
        contentFrame: {
          frameIndex: 3,
          frameCount: 9,
          timeMs: index * 1000 + 340,
          proof: { expected: "fixture text", actual: "fixture text", lines: ["fixture text"] },
        },
      })),
    },
    layoutDisplay: [{
      changeFrame: { frameIndex: 2, frameCount: 8, timeMs: 10 },
      contentFrame: { frameIndex: 4, frameCount: 8, timeMs: 110, sourceTimeRange: { lowerMs: 104, upperMs: 109 }, requestAtMs: 50, width: 120, height: 80,
        displayedAtMs: 109, nativePlacement: nativePlacement(120, 80, 100),
        surfaceEvents: [nativePlacement(120, 80, 100).placement],
        proof: { expected: "fixture text", actual: "fixture text", lines: ["fixture text"] } },
    }],
    drag: {
      recordedFrameCount: 10,
      firstGestureFrameIndex: 2,
      lastGestureFrameIndex: 4,
      gestureEndedFrameIndex: 4,
      gestureStartedAtMs: 70,
      gestureEndedAtMs: 100,
      geometryFrames: [
        { frameIndex: 2, timeMs: 80, cardRectPt: { left: 0, top: 0, right: 100, bottom: 80 },
          nativeRectPt: { left: 0, top: 0, right: 100, bottom: 80 },
          slotInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 } },
        { frameIndex: 3, timeMs: 88, cardRectPt: { left: 0, top: 0, right: 110, bottom: 80 },
          nativeRectPt: { left: 0, top: 0, right: 111, bottom: 80 },
          slotInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 } },
        { frameIndex: 4, timeMs: 96, cardRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
          nativeRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
          slotInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 } },
      ],
      tailGeometryFrames: [5, 6, 7, 8, 9].map((frameIndex, index) => ({
        frameIndex,
        timeMs: [120, 129, 150, 200, 251][index],
        cardRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
        nativeRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
        contentRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
        slotInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 },
        contentInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 },
      })),
      contentFrames: [
        contentFrame(0, 2, 80, 79, 81, 100, 100),
        contentFrame(1, 3, 88, 87, 89, 100, 110),
        contentFrame(2, 4, 96, 95, 97, 100, 120),
        contentFrame(3, 6, 128, 127, 129, 120, 120),
        contentFrame(4, 9, 250, 249, 251, 120, 120),
      ],
      events: [],
      finalPresentation: { displayedAtMs: 128, targetViewport: { width: 120, height: 80 },
        targetRectPt: { left: 0, top: 0, right: 120, bottom: 80 } },
      layouts: [{ ticket: 1, begun: 60, requested: 70, presented: 75, committed: 80 }],
      ticks: [70, 90],
    },
  };
}

test("view metrics accept exact thresholds and preserve frame and process evidence", { timeout: 1000 }, () => {
  const raw = metrics();
  const report = assertViewMeasurements(raw, options);
  assert.equal(report.evaluation.total.limitBytes, 16_000_000);
  assert.equal(report.evaluation.total.allViewsBytes, 16_000_000);
  assert.deepEqual(report.evaluation.reclaim.map((run) => run.returnedFraction), [0.9, 0.9, 0.9]);
  assert.equal(report.evaluation.warmDisplay.measuredMs, 310);
  assert.deepEqual(report.evaluation.newProcess.adjustedDisplayMs, [310, 310, 310]);
  assert.equal(report.evaluation.layoutDisplay[0].measuredMs, 100);
  assert.equal(report.evaluation.drag.maxGeometryErrorPt, 1);
  assert.equal(report.evaluation.drag.maxContentFrameIntervalMs, 8);
  assert.equal(report.evaluation.drag.convergedFrame, 2);
  assert.strictEqual(report.measurements, raw);
});

test("view metrics report independent failures together", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.total.allViewProcesses[2].footprintBytes += 1;
  raw.warmDisplay.contentFrame.proof.actual = "unrelated pixels";

  let failure;
  try {
    assertViewMeasurements(raw, options);
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof AggregateError);
  assert.equal(failure.errors.length, 2);
  assert.match(failure.errors[0].message, /^total:/u);
  assert.match(failure.errors[0].cause.message, /total\.allViewProcesses sums/u);
  assert.match(failure.errors[1].message, /^warmDisplay:/u);
  assert.match(failure.errors[1].cause.message, /proof\.actual/u);
});

test("layout source matches the WebKit viewport projected from a fractional native frame", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.layoutDisplay[0].contentFrame = {
    ...raw.layoutDisplay[0].contentFrame,
    width: 785,
    height: 286,
    nativePlacement: nativePlacement(785.5, 286.5, 100),
  };
  raw.layoutDisplay[0].contentFrame.surfaceEvents = [raw.layoutDisplay[0].contentFrame.nativePlacement.placement];
  assert.doesNotThrow(() => assertViewMeasurements(raw, options));
  assert.deepEqual(raw.layoutDisplay[0].contentFrame.nativePlacement.framePt,
    { x: 0.5, y: 1.5, width: 785.5, height: 286.5 });

  raw.layoutDisplay[0].contentFrame.width = 784;
  assert.throws(() => assertViewMeasurements(raw, options), /content frame matching the projected WebKit viewport/);

  const wrongProjection = metrics();
  wrongProjection.layoutDisplay[0].contentFrame.nativePlacement = nativePlacement(785.5, 286.5, 100);
  wrongProjection.layoutDisplay[0].contentFrame.surfaceEvents = [wrongProjection.layoutDisplay[0].contentFrame.nativePlacement.placement];
  wrongProjection.layoutDisplay[0].contentFrame.width = 785;
  wrongProjection.layoutDisplay[0].contentFrame.height = 286;
  wrongProjection.layoutDisplay[0].contentFrame.nativePlacement.webKitViewport.width = 786;
  assert.throws(() => assertViewMeasurements(wrongProjection, options), /per-axis integer truncation/);

  const stalePlacement = metrics();
  stalePlacement.layoutDisplay[0].contentFrame.nativePlacement.timeMs = 50;
  stalePlacement.layoutDisplay[0].contentFrame.nativePlacement.placement.mono_ns = 50_000_000;
  stalePlacement.layoutDisplay[0].contentFrame.nativePlacement.placement.ts_us = 50_000;
  assert.throws(() => assertViewMeasurements(stalePlacement, options), /applied placement after request/);

  const futurePlacement = metrics();
  futurePlacement.layoutDisplay[0].contentFrame.nativePlacement.timeMs = 111;
  futurePlacement.layoutDisplay[0].contentFrame.nativePlacement.placement.mono_ns = 111_000_000;
  futurePlacement.layoutDisplay[0].contentFrame.nativePlacement.placement.ts_us = 111_000;
  assert.throws(() => assertViewMeasurements(futurePlacement, options), /before displayed presentation 109 ms/);
});

test("layout source accepts an overlapping placement readback when display covers both clocks", { timeout: 1000 }, () => {
  const raw = metrics();
  const content = raw.layoutDisplay[0].contentFrame;
  content.nativePlacement.timeMs = 108;
  content.nativePlacement.placement.mono_ns = 108_000_000;
  content.nativePlacement.placement.ts_us = 108_000;
  content.displayedAtMs = 109;
  content.surfaceEvents = [content.nativePlacement.placement];

  const report = assertViewMeasurements(raw, options);

  assert.equal(report.measurements.layoutDisplay[0].contentFrame.nativePlacement.timeMs, 108);
  assert.equal(report.evaluation.layoutDisplay[0].contentFrame.timeMs, 110,
    "the captured source frame is after both the actual displayed presentation and source interval");
});

test("layout proof rejects a later competing placement but accepts an identical readback", { timeout: 1000 }, () => {
  const changed = metrics();
  const selected = changed.layoutDisplay[0].contentFrame.nativePlacement.placement;
  changed.layoutDisplay[0].contentFrame.nativePlacement.timeMs = 108;
  selected.mono_ns = 108_000_000;
  selected.ts_us = 108_000;
  changed.layoutDisplay[0].contentFrame.displayedAtMs = 109;
  const competing = structuredClone(selected);
  competing.seq = selected.seq + 1;
  competing.mono_ns = 109_500_000;
  competing.ts_us = 109_500;
  competing.fields.w = 130;
  changed.layoutDisplay[0].contentFrame.surfaceEvents = [selected, competing];

  assert.throws(() => assertViewMeasurements(changed, options), /later competing placement/);

  const unchanged = structuredClone(changed);
  unchanged.layoutDisplay[0].contentFrame.surfaceEvents[1].fields.w = selected.fields.w;
  assert.doesNotThrow(() => assertViewMeasurements(unchanged, options),
    "a repeated readback of the same target does not invalidate the capture");
});

test("drag source rows keep content dimensions without associating a native placement readback", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.drag.contentFrames[0] = {
    ...raw.drag.contentFrames[0],
    width: 785,
    height: 286,
  };
  delete raw.drag.contentFrames[0].nativePlacement;
  const report = assertViewMeasurements(raw, options);
  assert.equal(report.measurements.drag.contentFrames[0].width, 785);
  assert.equal(Object.hasOwn(report.measurements.drag.contentFrames[0], "nativePlacement"), false,
    "drag source dimensions do not require a per-source native placement association");
});

test("total footprint rejects one byte over the SI 10 MB margin", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.total.allViewProcesses[2].footprintBytes += 1;
  assert.throws(() => assertViewMeasurements(raw, options), /total\.allViewProcesses sums .* exceeding/);
});

test("total footprint rejects a zero-byte measurement for either process group", { timeout: 1000 }, () => {
  const noOneViewFootprint = metrics();
  noOneViewFootprint.total.oneViewProcesses[0].footprintBytes = 0;
  noOneViewFootprint.total.allViewProcesses = [process(201, 1_000_000)];
  assert.throws(() => assertViewMeasurements(noOneViewFootprint, options), /oneViewProcesses.*positive/);

  const noAllViewsFootprint = metrics();
  noAllViewsFootprint.total.allViewProcesses = [process(201, 0)];
  assert.throws(() => assertViewMeasurements(noAllViewsFootprint, options), /allViewProcesses.*positive/);
});

test("reclaim requires three initial-document-only group runs and exact 90 percent within 10 seconds", { timeout: 1000 }, () => {
  const below = metrics();
  below.reclaim[0].afterProcesses[0].footprintBytes = 1_000_001;
  assert.throws(() => assertViewMeasurements(below, options), /reclaim\[0\].*below 90%/);

  const late = metrics();
  late.reclaim[1].elapsedMs = 10_001;
  assert.throws(() => assertViewMeasurements(late, options), /elapsedMs 10001 exceeds 10000/);

  const cached = metrics();
  cached.reclaim[2].engineCacheHeld = true;
  assert.throws(() => assertViewMeasurements(cached, options), /engineCacheHeld/);

  const history = metrics();
  history.reclaim[1].closedViews[0].documents[0].historyEntries = 2;
  assert.throws(() => assertViewMeasurements(history, options), /exactly 1 initial document/);
});

test("warm display requires OCR proof tied to a recorded frame identity", { timeout: 1000 }, () => {
  const noProof = metrics();
  delete noProof.warmDisplay.contentFrame.proof;
  assert.throws(() => assertViewMeasurements(noProof, options), /warmDisplay\.contentFrame\.proof/);

  const mismatched = metrics();
  mismatched.warmDisplay.contentFrame.proof.actual = "unrelated pixels";
  assert.throws(() => assertViewMeasurements(mismatched, options), /does not contain the expected text/);
});

test("view OCR proof normalizes Unicode and whitespace but still rejects missing text", { timeout: 1000 }, () => {
  const spacedHangul = metrics();
  spacedHangul.warmDisplay.contentFrame.proof = {
    expected: "속삭한글문서확인",
    actual: "속삭 한글 문서 확인",
    lines: ["속삭 한글 문서 확인"],
  };
  assert.doesNotThrow(() => assertViewMeasurements(spacedHangul, options));

  const missingHangul = structuredClone(spacedHangul);
  missingHangul.warmDisplay.contentFrame.proof.actual = "속삭 한글 문서 누락";
  missingHangul.warmDisplay.contentFrame.proof.lines = ["속삭 한글 문서 누락"];
  assert.throws(() => assertViewMeasurements(missingHangul, options), /does not contain the expected text/);
});

test("warm display is explicitly not applicable when the opened view did not reuse a prior process", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.warmDisplay.openedPid = 82;
  delete raw.warmDisplay.contentFrame;
  const report = assertViewMeasurements(raw, options);
  assert.equal(report.evaluation.warmDisplay.applicable, false);
  assert.match(report.evaluation.warmDisplay.reason, /did not reuse/);
});

test("warm display validates its pre-request process snapshot", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.warmDisplay.beforePidsAtMs = 11;
  assert.throws(() => assertViewMeasurements(raw, options), /beforePidsAtMs.*<= requestAtMs 10/);
});

test("drag geometry requires every contiguous gesture frame and same-frame observations", { timeout: 1000 }, () => {
  const missing = metrics();
  missing.drag.geometryFrames.splice(1, 1);
  assert.throws(() => assertViewMeasurements(missing, options), /exactly 3 entries/);

  const outOfRange = metrics();
  outOfRange.drag.geometryFrames[0].frameIndex = 1;
  assert.throws(() => assertViewMeasurements(outOfRange, options), /frameIndex 2/);

  const missingInsets = metrics();
  delete missingInsets.drag.geometryFrames[0].slotInsetsPt;
  assert.throws(() => assertViewMeasurements(missingInsets, options), /slotInsetsPt/);

  const bottomEdge = metrics();
  bottomEdge.drag.geometryFrames[1].nativeRectPt.bottom = 83;
  assert.throws(() => assertViewMeasurements(bottomEdge, options), /geometry differs by 3 pt/);
});

test("drag geometry compares the native rectangle with its declared card slot", { timeout: 1000 }, () => {
  const chrome = metrics();
  chrome.drag.geometryFrames = [
    { frameIndex: 2, timeMs: 80, cardRectPt: { left: 0, top: 0, right: 100, bottom: 80 },
      nativeRectPt: { left: 5, top: 10, right: 95, bottom: 70 },
      slotInsetsPt: { left: 5, top: 10, right: 5, bottom: 10 } },
    { frameIndex: 3, timeMs: 88, cardRectPt: { left: 0, top: 0, right: 110, bottom: 80 },
      nativeRectPt: { left: 5, top: 10, right: 105, bottom: 70 },
      slotInsetsPt: { left: 5, top: 10, right: 5, bottom: 10 } },
    { frameIndex: 4, timeMs: 96, cardRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
      nativeRectPt: { left: 5, top: 10, right: 115, bottom: 70 },
      slotInsetsPt: { left: 5, top: 10, right: 5, bottom: 10 } },
  ];
  const report = assertViewMeasurements(chrome, options);
  assert.equal(report.evaluation.drag.maxGeometryErrorPt, 0);

  const drift = structuredClone(chrome);
  drift.drag.geometryFrames[1].nativeRectPt.right = 108;
  assert.throws(() => assertViewMeasurements(drift, options), /geometry differs by 3 pt/);

  const invalidInsets = structuredClone(chrome);
  invalidInsets.drag.geometryFrames[0].slotInsetsPt.left = -1;
  assert.throws(() => assertViewMeasurements(invalidInsets, options), /slotInsetsPt\.left/);

  const collapsedSlot = structuredClone(chrome);
  collapsedSlot.drag.geometryFrames[0].slotInsetsPt.left = 95;
  assert.throws(() => assertViewMeasurements(collapsedSlot, options), /positive card slot/);
});

test("drag cadence is in-gesture and convergence meets both frame and time bounds", { timeout: 1000 }, () => {
  const cadence = metrics();
  cadence.drag.contentFrames[1].frameTimeMs = 114;
  cadence.drag.contentFrames[1].timeRange = { lowerMs: 113, upperMs: 115 };
  cadence.drag.contentFrames[1].captureTimeMs = 115;
  cadence.drag.contentFrames[2].frameTimeMs = 120;
  cadence.drag.contentFrames[2].timeRange = { lowerMs: 119, upperMs: 121 };
  cadence.drag.contentFrames[2].captureTimeMs = 121;
  cadence.drag.contentFrames[3].frameTimeMs = 140;
  cadence.drag.contentFrames[3].timeRange = { lowerMs: 139, upperMs: 141 };
  cadence.drag.contentFrames[3].captureTimeMs = 141;
  cadence.drag.contentFrames[3].displayCapture = { frameIndex: 6, timeMs: 141 };
  cadence.drag.gestureEndedAtMs = 130;
  cadence.drag.tailGeometryFrames[1].timeMs = 141;
  assert.throws(() => assertViewMeasurements(cadence, options), /in-gesture content-frame interval 34 ms/);

  const tooManyFrames = metrics();
  tooManyFrames.drag.contentFrames[3].frameIndex = 7;
  tooManyFrames.drag.contentFrames[3].displayCapture.frameIndex = 7;
  tooManyFrames.drag.contentFrames[3].displayCapture.timeMs = 150;
  tooManyFrames.drag.tailGeometryFrames[1].contentRectPt.right = 117;
  assert.throws(() => assertViewMeasurements(tooManyFrames, options), /source-backed final-target paint capture/);

  const tooLate = metrics();
  tooLate.drag.gestureEndedAtMs = 130;
  tooLate.drag.contentFrames[3].frameIndex = 5;
  tooLate.drag.finalPresentation.targetViewport = { width: 130, height: 80 };
  tooLate.drag.finalPresentation.targetRectPt.right = 130;
  tooLate.drag.contentFrames.splice(4, 0,
    contentFrame(4, 6, 145, 144, 146, 120, 110),
    contentFrame(5, 6, 165, 164, 166, 130, 130));
  tooLate.drag.contentFrames[5].displayCapture = { frameIndex: 6, timeMs: 166 };
  tooLate.drag.contentFrames[6].sourceSequence = 6;
  assert.throws(() => assertViewMeasurements(tooLate, options), /source-backed final-target paint capture/);

  const alreadyMatched = metrics();
  alreadyMatched.drag.contentFrames.splice(3);
  alreadyMatched.drag.finalPresentation.targetViewport = { width: 100, height: 80 };
  alreadyMatched.drag.finalPresentation.targetRectPt.right = 100;
  alreadyMatched.drag.contentFrames[2].displayCapture = { frameIndex: 6, timeMs: 129 };
  for (const frame of alreadyMatched.drag.contentFrames) {
    frame.displayCapture = { frameIndex: 6, timeMs: 129 };
  }
  alreadyMatched.drag.tailGeometryFrames = alreadyMatched.drag.tailGeometryFrames.map((frame) => ({
    ...frame,
    cardRectPt: { left: 0, top: 0, right: 100, bottom: 80 },
    nativeRectPt: { left: 0, top: 0, right: 100, bottom: 80 },
    contentRectPt: { left: 0, top: 0, right: 100, bottom: 80 },
  }));
  const report = assertViewMeasurements(alreadyMatched, options);
  assert.equal(report.evaluation.drag.convergedFrame, 1,
    "already matching source dimensions still need a post-gesture target paint capture");
  assert.equal(report.evaluation.drag.paintCaptureFrameIndex, 5);
});

test("drag convergence uses the early source-backed paint capture instead of the late presentation barrier", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.drag.finalPresentation.displayedAtMs = 200;
  for (const frame of raw.drag.contentFrames) {
    if (frame.displayCapture) {
      frame.displayCapture = { frameIndex: 9, timeMs: Math.max(251, frame.timeRange.upperMs) };
    }
  }
  const report = assertViewMeasurements(raw, options);

  assert.equal(report.evaluation.drag.convergedFrame, 2,
    "the first target-size source frame was captured two frames after gesture end");
  assert.equal(report.evaluation.drag.convergenceMs, 29,
    "the source-backed paint capture, rather than the later presentation barrier, is within 33 ms");
  assert.equal(report.evaluation.drag.paintCaptureFrameIndex, 6);
  assert.equal(report.evaluation.drag.paintCaptureTimeMs, 129);
  assert.equal(report.evaluation.drag.paintSourceSequence, 3);
  assert.equal(report.evaluation.drag.eventualPresentationCaptureFrameIndex, 9,
    "the later presentation proof remains separate from the convergence capture");
});

test("drag convergence rejects absent or misaligned same-frame paint evidence", { timeout: 1000 }, () => {
  const missingPaint = metrics();
  missingPaint.drag.contentFrames[3].displayCapture = { frameIndex: 6, timeMs: 129 };
  missingPaint.drag.tailGeometryFrames[1].contentRectPt = null;
  assert.throws(() => assertViewMeasurements(missingPaint, options), /tailGeometryFrames\[1\]\.contentRectPt/);

  const stalePaint = metrics();
  stalePaint.drag.contentFrames[3].displayCapture = { frameIndex: 6, timeMs: 129 };
  stalePaint.drag.tailGeometryFrames.find(({ frameIndex }) => frameIndex === 6).contentRectPt.right = 117;
  assert.throws(() => assertViewMeasurements(stalePaint, options), /source-backed final-target paint capture/);
});

test("drag convergence selects a later qualifying paint capture when the first capture is stale", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.drag.contentFrames = [
    contentFrame(0, 2, 80, 79, 81, 100, 100),
    contentFrame(1, 3, 88, 87, 89, 100, 110),
    contentFrame(2, 4, 96, 95, 97, 100, 120),
    contentFrame(3, 5, 128, 127, 129, 120, 120),
    contentFrame(4, 6, 130, 129, 131, 120, 120),
  ];
  raw.drag.contentFrames[3].captureTimeMs = 129;
  raw.drag.contentFrames[4].captureTimeMs = 131;
  for (const frame of raw.drag.contentFrames.slice(3)) {
    frame.displayCapture = { frameIndex: 9, timeMs: 251 };
  }
  raw.drag.tailGeometryFrames[0].timeMs = 129;
  raw.drag.tailGeometryFrames[0].contentRectPt.right = 117;
  raw.drag.tailGeometryFrames[1].timeMs = 131;
  raw.drag.finalPresentation.targetRectPt = { left: 0, top: 0, right: 120, bottom: 80 };

  const report = assertViewMeasurements(raw, options);

  assert.equal(report.evaluation.drag.paintCaptureFrameIndex, 6,
    "a later matching capture within both deadline limits qualifies after the first capture is stale");
});

test("drag convergence accepts a final-size source interval that overlaps gesture end when later pixels prove it", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.drag.contentFrames = [
    contentFrame(0, 2, 80, 79, 81, 100, 100),
    contentFrame(1, 3, 88, 87, 89, 100, 110),
    contentFrame(2, 4, 96, 95, 97, 100, 120),
    contentFrame(3, 5, 100, 99, 101, 120, 120),
  ];
  raw.drag.contentFrames[3].captureTimeMs = 108;
  raw.drag.contentFrames[3].displayCapture = { frameIndex: 6, timeMs: 129 };
  raw.drag.tailGeometryFrames[0].timeMs = 108;
  raw.drag.finalPresentation.targetRectPt = { left: 0, top: 0, right: 120, bottom: 80 };

  const report = assertViewMeasurements(raw, options);

  assert.equal(report.evaluation.drag.convergedFrame, 1,
    "the actual final-size pixels are captured eight milliseconds after gesture end");
  assert.equal(report.evaluation.drag.paintSourceSequence, 3);
});

test("drag convergence requires a captured final paint when source dimensions already match", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.drag.contentFrames.splice(3);
  raw.drag.contentFrames[2].displayCapture = { frameIndex: 6, timeMs: 129 };
  for (const frame of raw.drag.contentFrames) {
    frame.displayCapture = { frameIndex: 6, timeMs: 129 };
  }
  raw.drag.finalPresentation.targetViewport = { width: 100, height: 80 };
  raw.drag.finalPresentation.targetRectPt = { left: 0, top: 0, right: 100, bottom: 80 };
  raw.drag.tailGeometryFrames = raw.drag.tailGeometryFrames.map((frame) => ({
    ...frame,
    cardRectPt: { left: 0, top: 0, right: 100, bottom: 80 },
    nativeRectPt: { left: 0, top: 0, right: 100, bottom: 80 },
    contentRectPt: { left: 0, top: 0, right: 100, bottom: 80 },
  }));

  const report = assertViewMeasurements(raw, options);

  assert.equal(report.evaluation.drag.paintCaptureFrameIndex, 5,
    "the already-final source state still needs actual captured paint evidence");
});

test("drag convergence rejects internally aligned paint at a different final target rectangle", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.drag.finalPresentation.targetRectPt = { left: 0, top: 0, right: 120, bottom: 80 };
  raw.drag.tailGeometryFrames = raw.drag.tailGeometryFrames.map((frame) => ({
    ...frame,
    cardRectPt: { left: 0, top: 0, right: 100, bottom: 80 },
    nativeRectPt: { left: 0, top: 0, right: 100, bottom: 80 },
    contentRectPt: { left: 0, top: 0, right: 100, bottom: 80 },
  }));

  assert.throws(() => assertViewMeasurements(raw, options), /source-backed final-target paint capture/);
});

test("drag convergence rejects a source-backed capture at 34.888 ms even when presentation was earlier", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.drag.recordedFrameCount = 67;
  raw.drag.firstGestureFrameIndex = 58;
  raw.drag.lastGestureFrameIndex = 60;
  raw.drag.gestureEndedFrameIndex = 60;
  raw.drag.geometryFrames = [58, 59, 60].map((frameIndex) => ({
    frameIndex,
    timeMs: 70 + frameIndex,
    cardRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
    nativeRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
    slotInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 },
  }));
  raw.drag.tailGeometryFrames = Array.from({ length: 6 }, (_, index) => ({
    frameIndex: 61 + index,
    timeMs: [120, 134.888, 150, 200, 251, 252][index],
    cardRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
    nativeRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
    contentRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
    slotInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 },
    contentInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 },
  }));
  raw.drag.contentFrames = [
    contentFrame(0, 58, 80, 79, 81, 100, 100),
    contentFrame(1, 59, 90, 89, 91, 110, 110),
    contentFrame(2, 60, 96, 95, 97, 100, 100),
    contentFrame(3, 62, 124, 123, 125, 120, 120),
  ];
  raw.drag.contentFrames[3].captureTimeMs = 134.888;
  raw.drag.contentFrames[3].displayCapture = { frameIndex: 62, timeMs: 134.888 };
  raw.drag.finalPresentation = { displayedAtMs: 125, targetViewport: { width: 120, height: 80 },
    targetRectPt: { left: 0, top: 0, right: 120, bottom: 80 } };

  assert.throws(() => assertViewMeasurements(raw, options), /source-backed final-target paint capture/);
});

test("drag cadence ignores an overlapping placement readback and converges against the presented viewport", { timeout: 1000 }, () => {
  const raw = metrics();
  const readback = nativePlacement(110, 80, 88);
  raw.drag.events = [readback.placement];
  raw.drag.contentFrames[1].nativePlacement = readback;
  raw.drag.finalPresentation = { displayedAtMs: 128, targetViewport: { width: 120, height: 80 },
    targetRectPt: { left: 0, top: 0, right: 120, bottom: 80 } };
  raw.drag.contentFrames[3].captureTimeMs = 130;
  raw.drag.contentFrames[3].displayCapture = { frameIndex: 6, timeMs: 130 };
  raw.drag.tailGeometryFrames[1].timeMs = 130;

  const report = assertViewMeasurements(raw, options);

  assert.equal(report.evaluation.drag.convergedFrame, 2,
    "the source frame after the last input matches the successfully presented final viewport");
  assert.equal(report.evaluation.drag.convergenceMs, 30,
    "convergence uses the actual source-backed pixel-capture time");
  assert.deepEqual(report.measurements.drag.events, [readback.placement],
    "the ambiguous native readback remains raw evidence without a per-source placement association");
});

test("drag cadence preserves distinct source frames that map to the same capture frame", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.drag.gestureStartedAtMs = 70;
  raw.drag.gestureEndedAtMs = 100;
  raw.drag.contentFrames = [
    contentFrame(1, 2, 68, 67, 69, 100, 100),
    contentFrame(2, 2, 80, 79, 81, 101, 110),
    contentFrame(3, 2, 88, 87, 89, 102, 110),
    contentFrame(4, 3, 96, 95, 97, 103, 120),
    contentFrame(5, 5, 112, 111, 113, 120, 120),
  ];
  raw.drag.contentFrames[4].displayCapture = { frameIndex: 6, timeMs: 128 };
  raw.drag.tailGeometryFrames = [5, 6, 7, 8, 9].map((frameIndex, index) => ({
    frameIndex,
    timeMs: [113, 128, 150, 200, 251][index],
    cardRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
    nativeRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
    contentRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
    slotInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 },
    contentInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 },
  }));
  const report = assertViewMeasurements(raw, options);
  assert.equal(report.evaluation.drag.maxContentFrameIntervalMs, 11);
  assert.equal(report.evaluation.drag.convergedFrame, 1);
});

test("drag cadence keeps captured boundary frames and their neighboring cadence evidence", { timeout: 1000 }, () => {
  const boundary = metrics();
  boundary.drag.contentFrames = [
    contentFrame(0, 1, 64, 63, 65, 100, 100),
    contentFrame(1, 2, 70, 69, 71, 100, 100),
    contentFrame(2, 3, 80, 79, 81, 100, 110),
    contentFrame(3, 4, 88, 87, 89, 100, 110),
    contentFrame(4, 4, 96, 95, 97, 100, 120),
    contentFrame(5, 5, 100, 99, 101, 120, 120),
    contentFrame(6, 6, 108, 107, 109, 120, 120),
    contentFrame(7, 8, 250, 249, 251, 120, 120),
  ];
  boundary.drag.contentFrames[6].displayCapture = { frameIndex: 9, timeMs: 260 };
  boundary.drag.contentFrames[7].displayCapture = { frameIndex: 9, timeMs: 260 };
  boundary.drag.tailGeometryFrames = [5, 6, 7, 8, 9].map((frameIndex, index) => ({
    frameIndex,
    timeMs: [100, 109, 150, 251, 260][index],
    cardRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
    nativeRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
    contentRectPt: { left: 0, top: 0, right: 120, bottom: 80 },
    slotInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 },
    contentInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 },
  }));
  const result = assertViewMeasurements(boundary, options);
  assert.equal(result.evaluation.drag.maxContentFrameIntervalMs, 10,
    "the possible start/end rows, nearest outside rows and all in-gesture rows bound cadence");

  const missingBoundaryCapture = structuredClone(boundary);
  missingBoundaryCapture.drag.contentFrames[1].frameIndex = null;
  missingBoundaryCapture.drag.contentFrames[1].captureTimeMs = null;
  missingBoundaryCapture.drag.contentFrames[1].displayCapture = null;
  assert.throws(() => assertViewMeasurements(missingBoundaryCapture, options), /capture frame for every possibly in-gesture/);
});

test("drag cadence excludes observer idle time outside the recorded gesture", { timeout: 1000 }, () => {
  const idle = metrics();
  idle.drag.gestureStartedAtMs = 11000;
  idle.drag.gestureEndedAtMs = 11030;
  idle.drag.finalPresentation.displayedAtMs = 11025;
  idle.drag.contentFrames = [
    contentFrame(0, null, 10000, 9999, 10001, 100, 100),
    contentFrame(1, 2, 11008, 11007, 11009, 100, 100),
    contentFrame(2, 3, 11016, 11015, 11017, 110, 110),
    contentFrame(3, 4, 11024, 11023, 11025, 120, 120),
    contentFrame(4, null, 20000, 19999, 20001, 120, 120),
  ];
  for (const frame of idle.drag.contentFrames) {
    if (frame.displayCapture) frame.displayCapture.timeMs = Math.max(idle.drag.finalPresentation.displayedAtMs,
      frame.timeRange.upperMs);
  }
  idle.drag.contentFrames[3].displayCapture = { frameIndex: 6, timeMs: 11032 };
  idle.drag.tailGeometryFrames = idle.drag.tailGeometryFrames.map((frame, index) => ({
    ...frame, timeMs: [11031, 11032, 11040, 11050, 11060][index],
  }));

  const report = assertViewMeasurements(idle, options);
  assert.equal(report.evaluation.drag.maxContentFrameIntervalMs, 9,
    "cadence includes the in-gesture parts of both boundary gaps and the exact in-gesture RAF gaps");
});

test("layout display measures the first pixel frame at the changed size", { timeout: 1000 }, () => {
  const delayed = metrics();
  delayed.layoutDisplay[0].contentFrame.timeMs = 111;
  assert.throws(() => assertViewMeasurements(delayed, options), /layoutDisplay\[0\].*exceeding 100 ms/);

  const wrongSize = metrics();
  wrongSize.layoutDisplay[0].contentFrame.width = 110;
  assert.throws(() => assertViewMeasurements(wrongSize, options), /content frame matching the projected WebKit viewport/);
});

test("editor footprint reports the exact SI 50 MB sidecar trigger without treating it as a pass value", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.editorFootprint = { viewBytes: 50_000_000, hiddenDomBytes: 62_000_000 };
  let report = assertViewMeasurements(raw, { ...options, measureEditorFootprint: true });
  assert.equal(report.evaluation.editorFootprint.sidecarRequired, false);
  raw.editorFootprint.viewBytes = 50_000_001;
  report = assertViewMeasurements(raw, { ...options, measureEditorFootprint: true });
  assert.equal(report.evaluation.editorFootprint.sidecarRequired, true);
});

function configDir(t) {
  const directory = mkdtempSync(join(tmpdir(), "soksak-view-measurements-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("view metric runner selects the host baseline and writes raw measurements and evaluation artifacts", { timeout: 1000 }, async (t) => {
  const raw = metrics();
  const diagnostics = [];
  const report = await runViewMeasurements({ diagnostic: (message) => diagnostics.push(message) }, {
    app: { name: "wailsv3", configDir: configDir(t) },
  }, {
    plugin: "fixture-view",
    baselinesMs: { wailsv3: 10, tauriv2: 20 },
    collect: async () => raw,
  });
  assert.strictEqual(report.measurements, raw);
  assert.equal(report.evaluation.baselineMs, 10);
  assert.equal(diagnostics.length, 1);
  const directory = diagnostics[0].replace("view measurement artifacts: ", "");
  assert.match(directory, /\/logs\/view-measurements-[^/]+$/u);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "measurements.json"), "utf8")), raw);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "evaluation.json"), "utf8")), report.evaluation);
  assert.deepEqual(readdirSync(directory).sort(), ["evaluation.json", "measurements.json"]);
});

test("view metric runner retains raw measurements and an error artifact when evaluation fails", { timeout: 1000 }, async (t) => {
  const raw = metrics();
  raw.total.allViewProcesses[2].footprintBytes += 1;
  const diagnostics = [];
  await assert.rejects(runViewMeasurements({ diagnostic: (message) => diagnostics.push(message) }, {
    app: { name: "wailsv3", configDir: configDir(t) },
  }, {
    plugin: "fixture-view",
    baselinesMs: { wailsv3: 10, tauriv2: 20 },
    collect: async () => raw,
  }), /total\.allViewProcesses sums .* exceeding/);
  assert.equal(diagnostics.length, 1);
  const directory = diagnostics[0].replace("view measurement artifacts: ", "");
  assert.match(directory, /\/logs\/view-measurements-[^/]+$/u);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "measurements.json"), "utf8")), raw);
  const error = JSON.parse(readFileSync(join(directory, "error.json"), "utf8"));
  assert.match(error.message, /total\.allViewProcesses sums .* exceeding/);
  assert.deepEqual(readdirSync(directory).sort(), ["error.json", "measurements.json"]);
});

test("view metric runner preserves independent failures in the error artifact", { timeout: 1000 }, async (t) => {
  const raw = metrics();
  raw.total.allViewProcesses[2].footprintBytes += 1;
  raw.warmDisplay.contentFrame.proof.actual = "unrelated pixels";
  const diagnostics = [];
  await assert.rejects(runViewMeasurements({ diagnostic: (message) => diagnostics.push(message) }, {
    app: { name: "wailsv3", configDir: configDir(t) },
  }, {
    plugin: "fixture-view",
    baselinesMs: { wailsv3: 10, tauriv2: 20 },
    collect: async () => raw,
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  });

  const directory = diagnostics[0].replace("view measurement artifacts: ", "");
  const error = JSON.parse(readFileSync(join(directory, "error.json"), "utf8"));
  assert.deepEqual(error.errors.map(({ message }) => message.split(":", 1)[0]), ["total", "warmDisplay"]);
  assert.match(error.errors[0].cause.message, /total\.allViewProcesses sums/u);
  assert.match(error.errors[1].cause.message, /proof\.actual/u);
  assert.equal(error.errors[0].cause.name, "AssertionError");
  assert.equal(error.errors[1].cause.name, "AssertionError");
});

test("view metrics allow an observed view with no attached child documents", { timeout: 1000 }, () => {
  const value = metrics();
  for (const run of value.reclaim) run.closedViews[0].documents = [];
  assert.doesNotThrow(() => assertViewMeasurements(value, options));
});

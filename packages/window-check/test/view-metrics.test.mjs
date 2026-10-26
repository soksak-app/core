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
    placement: { event: "host.trace.surface", ts_us: timeMs * 1000, mono_ns: monoNs,
      fields: { surface, phase: "placed", visible: true, x: framePt.x, y: framePt.y, w: width, h: height } } };
}

function contentFrame(sourceSequence, frameIndex, timeMs, width, nativeWidth) {
  return { sourceSequence, frameIndex, timeMs, width, height: 80,
    nativePlacement: nativePlacement(nativeWidth, 80, timeMs - 1) };
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
      contentFrame: { frameIndex: 4, frameCount: 8, timeMs: 110, sourceTimeMs: 109, requestAtMs: 50, width: 120, height: 80,
        nativePlacement: nativePlacement(120, 80, 100),
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
      contentFrames: [
        contentFrame(0, 2, 80, 100, 100),
        contentFrame(1, 3, 88, 100, 110),
        contentFrame(2, 4, 96, 100, 120),
        contentFrame(3, 6, 128, 120, 120),
        contentFrame(4, 9, 250, 120, 120),
      ],
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

test("layout source matches the WebKit viewport projected from a fractional native frame", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.layoutDisplay[0].contentFrame = {
    ...raw.layoutDisplay[0].contentFrame,
    width: 785,
    height: 286,
    nativePlacement: nativePlacement(785.5, 286.5, 100),
  };
  assert.doesNotThrow(() => assertViewMeasurements(raw, options));
  assert.deepEqual(raw.layoutDisplay[0].contentFrame.nativePlacement.framePt,
    { x: 0.5, y: 1.5, width: 785.5, height: 286.5 });

  raw.layoutDisplay[0].contentFrame.width = 784;
  assert.throws(() => assertViewMeasurements(raw, options), /content frame matching the projected WebKit viewport/);

  const wrongProjection = metrics();
  wrongProjection.layoutDisplay[0].contentFrame.nativePlacement = nativePlacement(785.5, 286.5, 100);
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
  assert.throws(() => assertViewMeasurements(futurePlacement, options), /<= source frame time 109 ms/);
});

test("drag source rows retain fractional native frames and use their explicit viewport projection", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.drag.contentFrames[0] = {
    ...raw.drag.contentFrames[0],
    width: 785,
    height: 286,
    nativePlacement: nativePlacement(785.5, 286.5, 79),
  };
  const report = assertViewMeasurements(raw, options);
  assert.deepEqual(report.measurements.drag.contentFrames[0].nativePlacement.framePt,
    { x: 0.5, y: 1.5, width: 785.5, height: 286.5 });
  assert.deepEqual(report.measurements.drag.contentFrames[0].nativePlacement.webKitViewport,
    { width: 785, height: 286 });
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
  cadence.drag.contentFrames[1].timeMs = 114;
  cadence.drag.contentFrames[2].timeMs = 120;
  cadence.drag.contentFrames[3].timeMs = 140;
  cadence.drag.gestureEndedAtMs = 130;
  assert.throws(() => assertViewMeasurements(cadence, options), /in-gesture content-frame interval 34 ms/);

  const tooManyFrames = metrics();
  tooManyFrames.drag.contentFrames[3].frameIndex = 7;
  assert.throws(() => assertViewMeasurements(tooManyFrames, options), /within 2 post-gesture frames/);

  const tooLate = metrics();
  tooLate.drag.contentFrames[3].timeMs = 134;
  assert.throws(() => assertViewMeasurements(tooLate, options), /within 33 ms after gesture end/);

  const alreadyMatched = metrics();
  alreadyMatched.drag.contentFrames[2].nativePlacement = nativePlacement(100, 80, 87);
  alreadyMatched.drag.contentFrames.splice(3);
  const report = assertViewMeasurements(alreadyMatched, options);
  assert.equal(report.evaluation.drag.convergedFrame, 0);
});

test("drag cadence preserves distinct source frames that map to the same capture frame", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.drag.gestureStartedAtMs = 70;
  raw.drag.gestureEndedAtMs = 100;
  raw.drag.contentFrames = [
    contentFrame(1, 2, 68, 100, 100),
    contentFrame(2, 2, 80, 101, 110),
    contentFrame(3, 2, 88, 102, 110),
    contentFrame(4, 3, 96, 103, 120),
    contentFrame(5, 5, 112, 120, 120),
  ];
  const report = assertViewMeasurements(raw, options);
  assert.equal(report.evaluation.drag.maxContentFrameIntervalMs, 8);
  assert.equal(report.evaluation.drag.convergedFrame, 1);
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

test("view metrics allow an observed view with no attached child documents", { timeout: 1000 }, () => {
  const value = metrics();
  for (const run of value.reclaim) run.closedViews[0].documents = [];
  assert.doesNotThrow(() => assertViewMeasurements(value, options));
});

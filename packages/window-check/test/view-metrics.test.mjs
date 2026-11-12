import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { assertViewMeasurements, domMountBaselineMs, runViewMeasurements } from "../view-metrics.mjs";

const options = { plugin: "fixture-view", host: "wailsv3", baselineMs: 10 };

function process(pid, footprintBytes) {
  return { pid, footprintBytes };
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
        timeMs: 320,
        proof: { method: "value", expected: "fixture text", actual: "fixture text" },
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
          timeMs: index * 1000 + 340,
          proof: { method: "value", expected: "fixture text", actual: "fixture text" },
        },
      })),
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
  assert.strictEqual(report.measurements, raw);
});

test("view metrics report independent failures together", { timeout: 1000 }, () => {
  const raw = metrics();
  raw.total.allViewProcesses[2].footprintBytes += 1;
  raw.warmDisplay.contentFrame.proof.actual = "unrelated text";

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

test("content proof accepts a value read that contains the declared text", { timeout: 1000 }, () => {
  const value = metrics();
  value.warmDisplay.contentFrame.proof = { method: "value", expected: "fixture", actual: "the fixture text" };
  assert.doesNotThrow(() => assertViewMeasurements(value, options));
});

test("content proof requires a proof on the content frame", { timeout: 1000 }, () => {
  const value = metrics();
  delete value.warmDisplay.contentFrame.proof;
  assert.throws(() => assertViewMeasurements(value, options), /warmDisplay\.contentFrame\.proof/);
});

test("content proof rejects a missing or different method", { timeout: 1000 }, () => {
  for (const method of [undefined, "text", "Value", ""]) {
    const value = metrics();
    if (method === undefined) delete value.warmDisplay.contentFrame.proof.method;
    else value.warmDisplay.contentFrame.proof.method = method;
    assert.throws(() => assertViewMeasurements(value, options), /warmDisplay\.contentFrame\.proof\.method/);
  }
});

test("content proof rejects a value read that does not contain the declared text", { timeout: 1000 }, () => {
  const value = metrics();
  value.warmDisplay.contentFrame.proof.actual = "unrelated text";
  assert.throws(() => assertViewMeasurements(value, options), /proof\.actual does not contain the expected text/);
});

test("content proof compares letter case exactly", { timeout: 1000 }, () => {
  const value = metrics();
  value.warmDisplay.contentFrame.proof.actual = "Fixture Text";
  assert.throws(() => assertViewMeasurements(value, options), /proof\.actual does not contain the expected text/);
});

test("content proof rejects empty or whitespace-only declared text", { timeout: 1000 }, () => {
  for (const expected of ["", " \n\t "]) {
    const value = metrics();
    value.warmDisplay.contentFrame.proof.expected = expected;
    assert.throws(() => assertViewMeasurements(value, options), /warmDisplay\.contentFrame\.proof\.expected/);
  }
});

test("content proof normalizes Unicode and whitespace but still rejects missing text", { timeout: 1000 }, () => {
  const spacedHangul = metrics();
  spacedHangul.warmDisplay.contentFrame.proof = {
    method: "value",
    expected: "속삭한글문서확인",
    actual: "속삭 한글 문서 확인",
  };
  assert.doesNotThrow(() => assertViewMeasurements(spacedHangul, options));

  const missingHangul = structuredClone(spacedHangul);
  missingHangul.warmDisplay.contentFrame.proof.actual = "속삭 한글 문서 누락";
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
    get: async () => ({ refreshRate: 120 }),
  }, {
    plugin: "fixture-view",
    baselinesMs: { wailsv3: 10, tauriv2: 20 },
    collect: async () => raw,
  });
  assert.strictEqual(report.measurements, raw);
  assert.equal(report.evaluation.baselineMs, 10);
  assert.equal(diagnostics.length, 2);
  const directory = diagnostics[0].replace("view measurement artifacts: ", "");
  assert.match(directory, /\/logs\/view-measurements-[^/]+$/u);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "measurements.json"), "utf8")), { ...raw, displayRefreshRate: 120 });
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "evaluation.json"), "utf8")), report.evaluation);
  assert.deepEqual(readdirSync(directory).sort(), ["evaluation.json", "measurements.json"]);
});

test("domMountBaselineMs gives each recorded host its value and mygo the lower of the two", () => {
  for (const recorded of [{ wailsv3: 13, tauriv2: 22 }, { wailsv3: 35, tauriv2: 13 }, { wailsv3: 17, tauriv2: 17 }]) {
    assert.equal(domMountBaselineMs("wailsv3", recorded), recorded.wailsv3);
    assert.equal(domMountBaselineMs("tauriv2", recorded), recorded.tauriv2);
    assert.equal(domMountBaselineMs("mygo", recorded), Math.min(recorded.wailsv3, recorded.tauriv2));
  }
});

test("domMountBaselineMs gives every host 0 for a plugin without a recorded value", () => {
  for (const host of ["wailsv3", "tauriv2", "mygo"]) assert.equal(domMountBaselineMs(host, null), 0);
});

test("domMountBaselineMs rejects an unknown host and a record that is not one value per recorded host", () => {
  assert.throws(() => domMountBaselineMs("other", { wailsv3: 13, tauriv2: 22 }), /DOM mount baseline host: expected wailsv3, tauriv2 or mygo, found "other"/);
  assert.throws(() => domMountBaselineMs("wailsv3", { wailsv3: 13 }), /DOM mount baseline recordedMs\.tauriv2: expected a finite number >= 0, found undefined/);
  assert.throws(() => domMountBaselineMs("mygo", { wailsv3: 13, tauriv2: 22, mygo: 9 }),
    /DOM mount baseline recordedMs: expected the keys wailsv3 and tauriv2, found \["wailsv3","tauriv2","mygo"\]/);
  assert.throws(() => domMountBaselineMs("wailsv3", undefined), /DOM mount baseline recordedMs: expected an object or null, found undefined/);
});

test("view metric runner evaluates the mygo host with the lower of the recorded baselines", { timeout: 1000 }, async (t) => {
  const report = await runViewMeasurements({ diagnostic() {} }, {
    app: { name: "mygo", configDir: configDir(t) },
    get: async () => ({ refreshRate: 120 }),
  }, {
    plugin: "fixture-view",
    baselinesMs: { wailsv3: 30, tauriv2: 20 },
    collect: async () => ({ ...metrics(), host: "mygo" }),
  });
  assert.equal(report.evaluation.host, "mygo");
  assert.equal(report.evaluation.baselineMs, 20);
});

test("view metric runner records the display refresh rate, because a skipped frame takes a different time at each rate", { timeout: 1000 }, async (t) => {
  const diagnostics = [];
  await runViewMeasurements({ diagnostic: (message) => diagnostics.push(message) }, {
    app: { name: "wailsv3", configDir: configDir(t) },
    get: async (name) => {
      assert.equal(name, "host.window");
      return { refreshRate: 60 };
    },
  }, {
    plugin: "fixture-view",
    baselinesMs: { wailsv3: 10, tauriv2: 20 },
    collect: async () => metrics(),
  });
  assert.equal(diagnostics[1], "view measurement display refresh rate: 60 Hz");
  const directory = diagnostics[0].replace("view measurement artifacts: ", "");
  assert.equal(JSON.parse(readFileSync(join(directory, "measurements.json"), "utf8")).displayRefreshRate, 60);
});

test("view metric runner refuses a window without a display refresh rate", { timeout: 1000 }, async (t) => {
  let collected = false;
  await assert.rejects(runViewMeasurements({ diagnostic: () => {} }, {
    app: { name: "wailsv3", configDir: configDir(t) },
    get: async () => ({ refreshRate: null }),
  }, {
    plugin: "fixture-view",
    baselinesMs: { wailsv3: 10, tauriv2: 20 },
    collect: async () => { collected = true; return metrics(); },
  }), /host\.window\.refreshRate/u);
  assert.equal(collected, false);
});

test("view metric runner retains raw measurements and an error artifact when evaluation fails", { timeout: 1000 }, async (t) => {
  const raw = metrics();
  raw.total.allViewProcesses[2].footprintBytes += 1;
  const diagnostics = [];
  await assert.rejects(runViewMeasurements({ diagnostic: (message) => diagnostics.push(message) }, {
    app: { name: "wailsv3", configDir: configDir(t) },
    get: async () => ({ refreshRate: 120 }),
  }, {
    plugin: "fixture-view",
    baselinesMs: { wailsv3: 10, tauriv2: 20 },
    collect: async () => raw,
  }), /total\.allViewProcesses sums .* exceeding/);
  assert.equal(diagnostics.length, 2);
  const directory = diagnostics[0].replace("view measurement artifacts: ", "");
  assert.match(directory, /\/logs\/view-measurements-[^/]+$/u);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "measurements.json"), "utf8")), { ...raw, displayRefreshRate: 120 });
  const error = JSON.parse(readFileSync(join(directory, "error.json"), "utf8"));
  assert.match(error.message, /total\.allViewProcesses sums .* exceeding/);
  assert.deepEqual(readdirSync(directory).sort(), ["error.json", "measurements.json"]);
});

test("view metric runner preserves independent failures in the error artifact", { timeout: 1000 }, async (t) => {
  const raw = metrics();
  raw.total.allViewProcesses[2].footprintBytes += 1;
  raw.warmDisplay.contentFrame.proof.actual = "unrelated text";
  const diagnostics = [];
  await assert.rejects(runViewMeasurements({ diagnostic: (message) => diagnostics.push(message) }, {
    app: { name: "wailsv3", configDir: configDir(t) },
    get: async () => ({ refreshRate: 120 }),
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

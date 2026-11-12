// The still rows of a recording (stills.mjs): reading stills.jsonl, the stills lost between two times, and the judgment that a
// recording judged at every still lost none of them.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { lostStills, readStills, requireNoLostStills } from "../stills.mjs";
import { writeStillRecording } from "../still-recording.mjs";

function rows(t, stills) {
  const directory = mkdtempSync(join(tmpdir(), "soksak-stills-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return readStills(writeStillRecording(directory, { gap: 8, ...stills }).stills);
}

test("the still rows hold the times of each still in ms and the path of its frame", (t) => {
  const [first, second] = rows(t, { until: 8, took: 0.5, lateBy: { 1: 9 } });
  assert.deepEqual({ ...first, frame: first.frame.split("/").at(-1) }, { index: 0, planned: 0, requested: 0, completed: 0.5, gap: 8,
    outcome: "written", error: null, frame: "frame-0000.bgra", windows: [7], late: false });
  assert.equal(second.late, true);
});

test("the stills lost between two times leave out the stills that the stop left unrequested", (t) => {
  const stills = rows(t, { until: 80, failed: [2], notRequested: [4], lateBy: { 6: 9 }, stoppedAt: 8 });
  assert.deepEqual(lostStills(stills, -Infinity, Infinity).map((row) => row.index), [2, 4, 6]);
  assert.deepEqual(lostStills(stills, 20, 48).map((row) => row.index), [4]);
});

// A judgment that looks at every still of a time cannot see what a lost still showed, so it requires that none was lost.
test("a recording judged at every still fails with the stills that it lost", (t) => {
  requireNoLostStills(rows(t, { until: 40, stoppedAt: 3 }), "the reload");
  assert.throws(() => requireNoLostStills(rows(t, { until: 40, failed: [1], notRequested: [3] }), "the reload"),
    /^Error: the recording lost 2 stills of the reload: still 1 planned at 8\.0ms failed \(the window server returned no image\), still 3 planned at 24\.0ms was not requested$/);
  assert.throws(() => requireNoLostStills(rows(t, { until: 40, failed: [1], notRequested: [3] }), "the modal", { from: 20 }),
    /^Error: the recording lost 1 stills of the modal: still 3 planned/);
});

// A still row whose fields contradict each other or its outcome is no still of the recording: the reader refuses it and names
// the row and the field.
function changedRow(t, change) {
  const directory = mkdtempSync(join(tmpdir(), "soksak-stills-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { stills } = writeStillRecording(directory, { gap: 8, until: 16, failed: [1], stoppedAt: 2 });
  const list = readFileSync(stills, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  change(list);
  writeFileSync(stills, list.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return () => readStills(stills);
}

test("a still row with an outcome other than written, failed and not-requested is refused", (t) => {
  assert.throws(changedRow(t, (list) => { list[0].outcome = "dropped"; }), /^Error: still row 0 of .*stills\.jsonl has the outcome "dropped"/);
});

test("a still row whose times are not exact decimal mach times is refused", (t) => {
  assert.throws(changedRow(t, (list) => { list[0].planned = 0; }), /^Error: still row 0 of .* has the planned time 0, not an exact decimal mach time$/);
  assert.throws(changedRow(t, (list) => { list[0].completed = "1.5"; }), /^Error: still row 0 of .* has the completed time "1\.5", not an exact decimal mach time$/);
});

test("a requested still row without its request or completion time, or an unrequested one with them, is refused", (t) => {
  assert.throws(changedRow(t, (list) => { list[0].completed = null; }), /^Error: still row 0 of .* is written without its completed time$/);
  assert.throws(changedRow(t, (list) => { list[2].requested = "16000000"; }), /^Error: still row 2 of .* is not-requested with a requested time$/);
});

test("a still row requested before its plan or completed before its request is refused", (t) => {
  assert.throws(changedRow(t, (list) => { list[1].planned = "9000000"; }), /^Error: still row 1 of .* was requested before its planned time$/);
  assert.throws(changedRow(t, (list) => { list[0].completed = "0"; list[0].requested = "1"; }), /^Error: still row 0 of .* completed before its request$/);
});

test("a still row whose frame is not the frame of a written still of its index is refused", (t) => {
  assert.throws(changedRow(t, (list) => { list[0].frame = "frame-0001.bgra"; }), /^Error: still row 0 of .* names the frame "frame-0001\.bgra", not frame-0000\.bgra$/);
  assert.throws(changedRow(t, (list) => { list[1].frame = "frame-0001.bgra"; }), /^Error: still row 1 of .* is failed and names the frame "frame-0001\.bgra"$/);
});

test("a failed still row without its error, or another row with one, is refused", (t) => {
  assert.throws(changedRow(t, (list) => { list[1].error = null; }), /^Error: still row 1 of .* failed without its error$/);
  assert.throws(changedRow(t, (list) => { list[0].error = "x"; }), /^Error: still row 0 of .* is written with the error "x"$/);
});

test("a requested still row without its window list, or an unrequested one with one, is refused", (t) => {
  assert.throws(changedRow(t, (list) => { list[0].windows = []; }), /^Error: still row 0 of .* has the window list \[\], not window numbers$/);
  assert.throws(changedRow(t, (list) => { list[2].windows = [7]; }), /^Error: still row 2 of .* is not-requested with a window list$/);
});

test("a still row whose gap or timebase is invalid, or whose timebase differs from the first row, is refused", (t) => {
  assert.throws(changedRow(t, (list) => { list[0].requestedGap = 0; }), /^Error: still row 0 of .* has the gap 0, not a positive number of ms$/);
  assert.throws(changedRow(t, (list) => { list[0].machTimebaseNumerator = 0; }), /^Error: still row 0 of .* has the mach timebase 0\/1, not positive integers$/);
  assert.throws(changedRow(t, (list) => { list[1].machTimebaseDenominator = 3; }), /^Error: still row 1 of .* has the mach timebase 1\/3, not the 1\/1 of the first row$/);
});

// A still whose windows could not be taken failed before it completed: it has no completion time and took no window.
test("a failed still row whose windows could not be taken has no completion time and an empty window list", (t) => {
  const rows = changedRow(t, (list) => { list[1].completed = null; list[1].windows = []; })();
  assert.deepEqual({ completed: rows[1].completed, windows: rows[1].windows, outcome: rows[1].outcome },
    { completed: null, windows: [], outcome: "failed" });
  assert.throws(changedRow(t, (list) => { list[1].completed = null; list[1].windows = null; }),
    /^Error: still row 1 of .* failed before its windows were taken and has the window list null, not \[\]$/);
  assert.throws(changedRow(t, (list) => { list[1].windows = []; }), /^Error: still row 1 of .* has the window list \[\], not window numbers$/);
  assert.throws(changedRow(t, (list) => { list[0].completed = null; }), /^Error: still row 0 of .* is written without its completed time$/);
});

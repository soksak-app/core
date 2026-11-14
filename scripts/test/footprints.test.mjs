import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { footprintOfResult, parseFootprint, parseFootprintPeak, SETTLE_RULE, settledFootprints, settleStep, settleWaitMs } from "../footprints.mjs";

const MB = 1024 * 1024;

test("reads phys_footprint of footprint, not the summary or the peak", () => {
  const text = [
    "=====================",
    "zsh [31610]: 64-bit    Footprint: 1687936 B (16384 bytes per page)",
    "=====================",
    "Auxiliary data:",
    "    phys_footprint: 1704320 B",
    "    phys_footprint_peak: 2000000 B",
    "",
  ].join("\n");
  assert.equal(parseFootprint(text), 1704320);
  assert.throws(() => parseFootprint("Footprint: 1687936 B\n"), /footprint output has no phys_footprint line/);
});

test("reads phys_footprint_peak of footprint", () => {
  const text = "    phys_footprint: 1704320 B\n    phys_footprint_peak: 2000000 B\n";
  assert.equal(parseFootprintPeak(text), 2000000);
  assert.throws(() => parseFootprintPeak("    phys_footprint: 1704320 B\n"), /footprint output has no phys_footprint_peak line/);
});

// The recordings of footprint -p PID -f bytes of a running process and of a process that ended (scripts/test/fixtures/measure-app-usage).
const recorded = (name) => JSON.parse(readFileSync(join(fileURLToPath(new URL("./fixtures/measure-app-usage/", import.meta.url)), `${name}.json`), "utf8"));

test("a footprint reading is the footprint and the peak of the output of footprint -p PID -f bytes, and a failure names the process", () => {
  const running = recorded("footprint-running");
  assert.deepEqual(running.command, ["footprint", "-p", String(running.pid), "-f", "bytes"]);
  assert.deepEqual(footprintOfResult(running.pid, running), { bytes: 12027560, peakBytes: 12027560 });
  const ended = recorded("footprint-ended");
  assert.throws(() => footprintOfResult(ended.pid, ended), new RegExp(`footprint -p ${ended.pid} exited with 66: footprint: Unable to find pid for process matching '${ended.pid}'`));
  assert.throws(() => footprintOfResult(12, { status: 0, stdout: "Footprint: 1 B\n", stderr: "" }), /footprint -p 12: footprint output has no phys_footprint line/);
});

/** The judgement of the readings of a settle test, each as { footprints, framesBefore, frames } after the first, in order. */
function judge(list, readings) {
  let previous = null;
  return list.map(({ footprints, framesBefore, frames }, index) => {
    const outcome = settleStep({ previous, framesBefore, frames, footprints: new Map(footprints), reading: index + 1, readings });
    previous = { footprints: new Map(footprints), frames };
    return outcome;
  });
}

test("footprints settle when two readings 5 seconds apart differ by less than 1,024 KB and the reading is 3 seconds after the last frame", () => {
  assert.deepEqual(SETTLE_RULE, { intervalMs: 5000, bytes: 1024 * 1024, quietMs: 3000 });
  assert.deepEqual(judge([
    { footprints: [[10, 100 * MB], [20, 50 * MB]], framesBefore: [340], frames: [340] },
    { footprints: [[10, 102 * MB], [20, 50 * MB]], framesBefore: [340], frames: [340] },
    // The third reading follows a frame of its last 3 seconds, so it is not after the last frame although its footprints are close.
    { footprints: [[10, 102.5 * MB], [20, 50.2 * MB]], framesBefore: [340], frames: [341] },
    { footprints: [[10, 102.6 * MB], [20, 50.3 * MB]], framesBefore: [341], frames: [341] },
  ], 5), ["again", "again", "again", "settled"]);
});

test("the waits of the settle rule are 3 seconds after the frames reading and 5 seconds after the frames reading of the reading before", () => {
  // The waits of a run whose footprint readings take no time: 3 s, then 2 s and 3 s for each next reading.
  assert.deepEqual([0, 1000, 3000, 4000].map((now) => settleWaitMs({ wait: "quiet", since: 0, now })), [3000, 2000, 0, 0]);
  assert.deepEqual([3000, 4000, 5000, 6000].map((now) => settleWaitMs({ wait: "interval", since: 0, now })), [2000, 1000, 0, 0]);
  assert.equal(settleWaitMs({ wait: "interval", since: 10_000, now: 13_000 }), 2000);
  assert.throws(() => settleWaitMs({ wait: "later", since: 0, now: 0 }), /the settle wait is quiet or interval, not "later"/);
});

test("a window whose frames is null counts no frame in the settle rule", () => {
  assert.deepEqual(judge([
    { footprints: [[10, 4 * MB]], framesBefore: [null], frames: [null] },
    { footprints: [[10, 4 * MB]], framesBefore: [null], frames: [null] },
  ], 24), ["again", "settled"]);
});

test("footprints that do not settle within their readings fail with the last two readings", async () => {
  assert.throws(() => judge([
    { footprints: [[10, 2 * MB]], framesBefore: [null], frames: [null] },
    { footprints: [[10, 4 * MB]], framesBefore: [null], frames: [null] },
    { footprints: [[10, 6 * MB]], framesBefore: [null], frames: [null] },
  ], 3), /the footprints did not settle within 3 readings 5 s apart; pid 10: 4096 KB then 6144 KB; frames null then null in the last 3 s/);
  await assert.rejects(settledFootprints({ readFootprints: null, readFrames: null, readings: 1 }), /settledFootprints needs at least 2 readings, not 1/);
});

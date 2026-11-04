import assert from "node:assert/strict";
import test from "node:test";

import { parseFootprint, parseFootprintPeak, readFootprint, SETTLE_RULE, settledFootprints } from "../footprints.mjs";

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

test("reading a footprint runs footprint -p PID -f bytes and names the process of a failure", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (args[1] === "10") return { status: 0, stdout: "    phys_footprint: 4096 B\n    phys_footprint_peak: 8192 B\n", stderr: "" };
    if (args[1] === "11") return { status: 1, stdout: "", stderr: "footprint: no process 11\n" };
    return { status: 0, stdout: "Footprint: 1 B\n", stderr: "" };
  };
  assert.deepEqual(await readFootprint(10, run), { bytes: 4096, peakBytes: 8192 });
  assert.deepEqual(calls, ["footprint -p 10 -f bytes"]);
  await assert.rejects(readFootprint(11, run), /footprint -p 11 exited with 1: footprint: no process 11/);
  await assert.rejects(readFootprint(12, run), /footprint -p 12: footprint output has no phys_footprint line/);
});

/** A reader of the footprints and the frames of a settle test: each footprint reading is preceded and followed by a frame reading. */
function readings(footprints, frames) {
  return {
    readFootprints: async () => new Map(footprints.shift()),
    readFrames: async () => frames.shift(),
  };
}

test("footprints settle when two readings 5 seconds apart differ by less than 1,024 KB and the reading is 3 seconds after the last frame", async () => {
  assert.deepEqual(SETTLE_RULE, { intervalMs: 5000, bytes: 1024 * 1024, quietMs: 3000 });
  const waits = [];
  const settled = await settledFootprints({
    ...readings(
      [[[10, 100 * MB], [20, 50 * MB]], [[10, 102 * MB], [20, 50 * MB]], [[10, 102.5 * MB], [20, 50.2 * MB]], [[10, 102.6 * MB], [20, 50.3 * MB]]],
      // The third reading follows a frame of its last 3 seconds, so it is not after the last frame although its footprints are close.
      [[340], [340], [340], [340], [340], [341], [341], [341]],
    ),
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.deepEqual([...settled.footprints], [[10, 102.6 * MB], [20, 50.3 * MB]]);
  assert.deepEqual(settled.frames, [341]);
  assert.deepEqual(waits, [3000, 2000, 3000, 2000, 3000, 2000, 3000]);
});

test("a window whose frames is null counts no frame in the settle rule", async () => {
  const settled = await settledFootprints({
    ...readings([[[10, 4 * MB]], [[10, 4 * MB]]], [[null], [null], [null], [null]]),
    sleep: async () => {},
  });
  assert.deepEqual([...settled.footprints], [[10, 4 * MB]]);
});

test("footprints that do not settle within their readings fail with the last two readings", async () => {
  let reading = 0;
  await assert.rejects(settledFootprints({
    readFootprints: async () => new Map([[10, ++reading * 2 * MB]]),
    readFrames: async () => [null],
    sleep: async () => {},
    readings: 3,
  }), /the footprints did not settle within 3 readings 5 s apart; pid 10: 4096 KB then 6144 KB; frames null then null in the last 3 s/);
  await assert.rejects(settledFootprints({ readFootprints: async () => new Map(), readFrames: async () => [], sleep: async () => {}, readings: 1 }),
    /settledFootprints needs at least 2 readings, not 1/);
});

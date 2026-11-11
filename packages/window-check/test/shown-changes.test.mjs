// The judgment of a recording by the changes of the screen that its check asked for (judgeShownChanges) and the clock that a
// check reads before it asks for a change (owe).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { judgeShownChanges, owe } from "../app.mjs";

/**
 * A stop reply whose recording holds complete frames displayed at `frames` and display-link callbacks at `mainThread` (ms on the
 * clock of the recording, a timebase of nanoseconds), with the transactions `layouts`.
 */
function stopReply(t, { frames, mainThread = [], layouts = [] }) {
  const directory = mkdtempSync(join(tmpdir(), "soksak-shown-changes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const callbackStatus = join(directory, "callback-status.jsonl");
  writeFileSync(callbackStatus, frames.map((ms, index) => JSON.stringify({ sequence: index + 1, status: 0,
    frame: `frame-${index + 1}.bgra`, displayTime: String(Math.round(ms * 1e6)), machTimebaseNumerator: 1,
    machTimebaseDenominator: 1 })).join("\n") + "\n");
  const displayLink = join(directory, "display-link.json");
  writeFileSync(displayLink, JSON.stringify({ state: "available", reason: "", omittedObservations: 0,
    observations: mainThread.map((ms, index) => ({ sequence: index + 1, callbackTime: String(Math.round(ms * 1e6)),
      machTimebaseNumerator: 1, machTimebaseDenominator: 1 })) }));
  const longestGap = Math.max(...frames.slice(1).map((ms, i) => ms - frames[i]));
  return { frames: directory, callbackStatus, displayLink, count: frames.length, limited: false, longestGap, layouts };
}

// A click recording: the window stays unchanged before the first click, between the clicks and after the last one is shown,
// so its longest gap is 400ms, and each click is shown 30ms after it was asked for.
test("a recording whose changes are each shown within the limit passes however long the window stays unchanged between them", (t) => {
  const stopped = stopReply(t, { frames: [0, 230, 238, 640, 648, 1100] });
  assert.equal(stopped.longestGap, 452);
  judgeShownChanges(stopped, [200, 610]);
});

test("a change that the application shows later than the limit fails as a defect of the application", (t) => {
  const stopped = stopReply(t, {
    frames: [0, 8, 16, 230],
    mainThread: [2, 10, 18, 26, 34, 120, 128, 136, 144, 152, 160, 168, 176, 184, 192, 200, 208, 216, 224],
    layouts: [{ ticket: 4, begun: 22, requested: 23, presented: null, committed: 232 }],
  });
  assert.throws(() => judgeShownChanges(stopped, [20], { what: "click" }), new RegExp("^Error: the application did not show " +
    "click 1 of 1, asked at 20\\.0ms on the clock of the recording, within 100ms: the next frame was displayed 210ms later, " +
    "at 230\\.0ms; in that time the check asked for 1 clicks, the host began 1 layouts \\[4\\] and committed 0 \\[\\], and the " +
    "main thread of the host ran no display-link callback for 86ms of it; recording .*soksak-shown-changes-[^;]*; 1-minute " +
    "load average \\d+\\.\\d\\d$"));
});

test("a recording judged without the times of its changes fails", (t) => {
  const stopped = stopReply(t, { frames: [0, 8] });
  for (const owed of [undefined, null, [Number.NaN]]) {
    assert.throws(() => judgeShownChanges(stopped, owed), /^Error: the recording has no times of the changes that it shows/);
  }
});

test("a recording in which the check asked for no change passes", (t) => {
  judgeShownChanges(stopReply(t, { frames: [0, 500] }), []);
});

test("owe reads the clock of the recordings in milliseconds", async () => {
  const requests = [];
  const s = { request: async (method, params) => { requests.push([method, params]); return { mono_ns: "401053467912345" }; } };
  assert.equal(await owe(s), 401053467.912345);
  assert.deepEqual(requests, [["diagnostics.clock", {}]]);
  await assert.rejects(owe({ request: async () => ({ mono_ns: 5 }) }), /^Error: diagnostics.clock returned an invalid mono_ns 5$/);
});

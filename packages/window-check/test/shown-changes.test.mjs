// The judgment of a recording by the changes of the screen that its check asked for (judgeShownChanges) and the clock that a
// check reads before it asks for a change (owe).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { judgeShownChanges, owe } from "../app.mjs";
import { writeStillRecording } from "./still-recording.mjs";

/**
 * A stop reply whose still recording takes a still every 8ms from 0 to `until` (ms on the clock of the recording, a timebase of
 * nanoseconds), each completed 1ms after its request, of a window that changes at `changes`, with display-link callbacks at
 * `mainThread` and the transactions `layouts`. A callback is its time, which runs 0.5ms after its refresh, or {at, refresh,
 * occluded, inFront}, where occluded tells that no part of the window showed at the callback and inFront lists the windows in
 * front of it that the callback read; the display refreshes every 8.333ms. `failed`, `notRequested` and `lateBy` lose or delay
 * stills as the host records them.
 */
function stopReply(t, { changes, until = Math.max(0, ...changes) + 16, mainThread = [], layouts = [], ...stills }) {
  const directory = mkdtempSync(join(tmpdir(), "soksak-shown-changes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return writeStillRecording(directory, { ...stills, until, changes, took: 1, layouts, displayLink: { state: "available",
    reason: "", omittedObservations: 0, observations: mainThread.map((callback, index) => {
      const { at, refresh = at - 0.5, occluded = false, inFront } = typeof callback === "number" ? { at: callback } : callback;
      return { sequence: index + 1, visible: true, occluded, ...(inFront ? { inFront } : {}), callbackTime: String(Math.round(at * 1e6)), callbackMediaTime: at / 1000,
        timestamp: refresh / 1000, targetTimestamp: (refresh + 8.333) / 1000, duration: 0.008333, machTimebaseNumerator: 1,
        machTimebaseDenominator: 1 };
    }) } });
}

// A click recording: the window stays unchanged before the first click, between the clicks and after the last one is shown,
// for 400ms between them; each click is shown about 30ms after it was asked for and its final state 8ms later.
test("a recording whose changes are each shown within the limit passes however long the window stays unchanged between them", (t) => {
  const stopped = stopReply(t, { changes: [230, 238, 640, 648], until: 1100 });
  judgeShownChanges(stopped, [{ from: 200, to: 238 }, { from: 610, to: 648 }]);
});

// Every still is a frame of the recording, also while the window stays as it is: only a still that differs from the still
// before it shows a change.
test("stills that show the window unchanged do not end the wait for a change", (t) => {
  const stopped = stopReply(t, { changes: [230], until: 300 });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }]), /the first still that shows a change completed 213ms later, at 233\.0ms/);
});

// The main thread runs the callback of the refresh at 42ms only at 120ms: the main thread was busy.
test("a change that the application shows later than the limit fails as a defect of the application", (t) => {
  const stopped = stopReply(t, {
    changes: [8, 16, 230],
    mainThread: [2, 10, 18, 26, 34, { at: 120, refresh: 42 }, 128, 136, 144, 152, 160, 168, 176, 184, 192, 200, 208, 216, 224],
    layouts: [{ ticket: 4, begun: 22, requested: 23, presented: 95, committed: 100.25 },
      { ticket: 5, begun: 101, requested: 102, presented: null, committed: 232 }],
  });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }], { what: "click" }), new RegExp("^Error: the application did " +
    "not show click 1 of 1 \\(asked at 20\\.0ms on the clock of the recording\\) without waiting longer than 100ms for a frame: " +
    "after 20\\.0ms the first still that shows a change completed 213ms later, at 233\\.0ms \\(requested at 232\\.0ms\\); in " +
    "that time the check asked for 1 clicks, the host began 2 layouts \\[4,5\\] and committed 2 \\[4 at 100\\.3ms, 5 at " +
    "232\\.0ms\\], and the display link of the window was silent for longer " +
    "than two refreshes once: after its callback at 34\\.0ms the main thread ran the display-link callback 78\\.0ms after its " +
    "refresh, at 120\\.0ms \\(busy main thread\\); recording .*soksak-shown-changes-[^;]*; 1-minute load average \\d+\\.\\d\\d$"));
});

// The next callback after 34ms runs 0.5ms after its refresh at 119.5ms: no refresh came in between, whatever the main thread did.
test("a silence of the display link in which no refresh reached the window is told from a busy main thread", (t) => {
  const stopped = stopReply(t, { changes: [8, 16, 230], mainThread: [2, 10, 18, 26, 34, 120, 128, 136, 224] });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }]), new RegExp("and committed 0 \\[\\], and the display link of " +
    "the window was silent for longer than two refreshes 2 times: after its callback at 34\\.0ms no display refresh reached the " +
    "window for 86ms \\(the display link received no vsync\\); after its callback at 136\\.0ms no display refresh reached the " +
    "window for 88ms \\(the display link received no vsync\\); recording "));
});

test("a display link that calls back at every refresh of the wait is named so", (t) => {
  const mainThread = Array.from({ length: 28 }, (_, i) => 2 + 8 * i);
  const stopped = stopReply(t, { changes: [8, 16, 230], mainThread });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }]),
    /and the display link of the window called back at every refresh of it; recording /);
});

// The window reports at each display-link callback whether any part of it shows (NSWindow.occlusionState). A wait in which the
// window showed nothing names how many of its callbacks found the window covered, so a covered window is told from one in front.
// The first callback of a covered stretch reads the windows in front of the window, so the failure names what covered it.
test("a wait in which the window was covered names the callbacks that found it covered and the windows in front of it", (t) => {
  const cover = [{ number: 9, owner: "Cover", pid: 300, layer: 0, x: 200, y: 30, width: 1400, height: 900 },
    { number: 12, owner: "Self", pid: 100, layer: 3, x: 400, y: 100, width: 50, height: 20 }];
  const mainThread = Array.from({ length: 28 }, (_, i) => ({ at: 2 + 8 * i, occluded: i >= 2, ...(i === 2 ? { inFront: cover } : {}) }));
  const stopped = stopReply(t, { changes: [8, 16, 230], mainThread });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }]), new RegExp("and the display link of the window called back " +
    "at every refresh of it, and no part of the window showed \\(NSWindow occlusion\\) at 25 of its 25 display-link callbacks " +
    "in that time, the first at 26\\.0ms, with in front of it, as read at 18\\.0ms: \\[Cover \\(pid 300, window 9, level 0\\) " +
    "at 200,30 1400x900, Self \\(pid 100, window 12, level 3\\) at 400,100 50x20\\]; recording "));
});

test("a covered wait whose recording read no windows in front of the window says so", (t) => {
  const mainThread = Array.from({ length: 28 }, (_, i) => ({ at: 2 + 8 * i, occluded: i >= 4 }));
  const stopped = stopReply(t, { changes: [8, 16, 230], mainThread });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }]), new RegExp("at 24 of its 25 display-link callbacks in that " +
    "time, the first at 34\\.0ms, and the recording read no list of the windows in front of it; recording "));
});

test("a covered wait in which the window server listed no window in front of the window says so", (t) => {
  const mainThread = Array.from({ length: 28 }, (_, i) => ({ at: 2 + 8 * i, occluded: i >= 4, ...(i === 4 ? { inFront: [] } : {}) }));
  const stopped = stopReply(t, { changes: [8, 16, 230], mainThread });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }]), new RegExp("the first at 34\\.0ms, with in front of it, as " +
    "read at 34\\.0ms: no window; recording "));
});

test("a wait in which the window showed at every display-link callback names no covered callback", (t) => {
  const mainThread = Array.from({ length: 28 }, (_, i) => 2 + 8 * i);
  const stopped = stopReply(t, { changes: [8, 16, 230], mainThread });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }]), (error) => !/no part of the window showed/.test(error.message));
});

// The layouts of a drag come with its reply and not with the stop reply, so the recording keeps those that it was judged by.
test("a judged recording keeps the layouts that it was judged by", (t) => {
  const layouts = [{ ticket: 9, begun: 3, requested: 4, presented: 6, committed: 7 }];
  const stopped = stopReply(t, { changes: [8, 16], layouts: [] });
  judgeShownChanges(stopped, [{ from: 2 }], { layouts });
  assert.deepEqual(JSON.parse(readFileSync(join(stopped.frames, "layouts.json"), "utf8")), { layouts });
  const failed = stopReply(t, { changes: [300], layouts });
  assert.throws(() => judgeShownChanges(failed, [{ from: 2 }]));
  assert.deepEqual(JSON.parse(readFileSync(join(failed.frames, "layouts.json"), "utf8")), { layouts });
});

// A transition that the window shows through several frames: its first frame comes 20ms after the request, and then the
// window waits 150ms before the frame that shows the final state.
test("a change shown through several frames fails when a frame of it comes later than the limit after the frame before it", (t) => {
  const stopped = stopReply(t, { changes: [120, 128, 278, 286], until: 900 });
  judgeShownChanges(stopped, [{ from: 100, to: 128 }]);
  assert.throws(() => judgeShownChanges(stopped, [{ from: 100, to: 286 }], { what: "full screen click" }), new RegExp(
    "^Error: the application did not show full screen click 1 of 1 \\(asked at 100\\.0ms, its final state displayed at " +
    "286\\.0ms on the clock of the recording\\) without waiting longer than 100ms for a frame: after 129\\.0ms the first still " +
    "that shows a change completed 152ms later, at 281\\.0ms \\(requested at 280\\.0ms\\);"));
});

test("a change whose final state the recording does not reach fails", (t) => {
  const stopped = stopReply(t, { changes: [120], until: 120 });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 100, to: 200 }]),
    /without waiting longer than 100ms for a frame: the recording shows no change after 121\.0ms;/);
});

// A still that failed, that was not requested or that was requested later than one gap after its plan leaves a time in which
// the recording could not see the window: a long wait across it is a loss of the recording, not a defect of the application,
// so the failure names those stills.
test("a long wait across stills that the recording lost fails as a loss of the recording and names those stills", (t) => {
  const failed = stopReply(t, { changes: [8, 230], failed: [3, 4], notRequested: [29], until: 248 });
  assert.throws(() => judgeShownChanges(failed, [{ from: 20 }]), new RegExp("^Error: the recording lost 3 stills while change 1 " +
    "of 1 \\(asked at 20\\.0ms on the clock of the recording\\) waited longer than 100ms for a frame: still 3 planned at " +
    "24\\.0ms failed \\(the window server returned no image\\), still 4 planned at 32\\.0ms failed \\(the window server " +
    "returned no image\\), still 29 planned at 232\\.0ms was not requested; after 20\\.0ms the first still that shows a change " +
    "completed 221ms later, at 241\\.0ms \\(requested at 240\\.0ms\\); in that time "));
  const late = stopReply(t, { changes: [8, 230], lateBy: { 5: 30 }, until: 240 });
  assert.throws(() => judgeShownChanges(late, [{ from: 20 }]), new RegExp("^Error: the recording lost 1 stills while change 1 " +
    "of 1 .*: still 5 planned at 40\\.0ms was requested 30\\.0ms late; after 20\\.0ms the first still that shows a change " +
    "completed 213ms later"));
});

// A lost still within a wait shorter than the limit hides nothing that the judgment needs: the wait to the next still that
// shows the change is at most the wait that the lost still would have ended.
test("a recording that lost stills passes when every change waited no longer than the limit across them", (t) => {
  judgeShownChanges(stopReply(t, { changes: [40, 48], failed: [4], notRequested: [7], lateBy: { 9: 12 }, until: 120 }),
    [{ from: 30, to: 48 }]);
});

test("a recording judged without the times of its changes fails", (t) => {
  const stopped = stopReply(t, { changes: [8] });
  for (const owed of [undefined, null, [{ from: Number.NaN }], [{ from: 1, to: "2" }], [5]]) {
    assert.throws(() => judgeShownChanges(stopped, owed), /^Error: the recording has no times of the changes that it shows/);
  }
});

test("a recording in which the check asked for no change passes", (t) => {
  judgeShownChanges(stopReply(t, { changes: [500] }), []);
});

test("owe reads the clock of the recordings in milliseconds", async () => {
  const requests = [];
  const s = { request: async (method, params) => { requests.push([method, params]); return { mono_ns: "401053467912345" }; } };
  assert.equal(await owe(s), 401053467.912345);
  assert.deepEqual(requests, [["diagnostics.clock", {}]]);
  await assert.rejects(owe({ request: async () => ({ mono_ns: 5 }) }), /^Error: diagnostics.clock returned an invalid mono_ns 5$/);
});

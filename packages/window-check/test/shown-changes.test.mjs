// The judgment of a recording by the changes of the screen that its check asked for (judgeShownChanges) and the clock that a
// check reads before it asks for a change (owe).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NOT_JUDGED, NotJudged, judgeShownChanges, judgedWhileShown, owe } from "../app.mjs";

/**
 * A stop reply whose recording holds complete frames displayed at `frames` and display-link callbacks at `mainThread` (ms on the
 * clock of the recording, a timebase of nanoseconds), with the transactions `layouts`. A callback is its time, which runs 0.5ms
 * after its refresh, or {at, refresh, occluded, inFront}, where occluded tells that no part of the window showed at the callback
 * and inFront lists the windows in front of it that the callback read; the display refreshes every 8.333ms.
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
    observations: mainThread.map((callback, index) => {
      const { at, refresh = at - 0.5, occluded = false, inFront } = typeof callback === "number" ? { at: callback } : callback;
      return { sequence: index + 1, visible: true, occluded, ...(inFront ? { inFront } : {}), callbackTime: String(Math.round(at * 1e6)), callbackMediaTime: at / 1000,
        timestamp: refresh / 1000, targetTimestamp: (refresh + 8.333) / 1000, duration: 0.008333, machTimebaseNumerator: 1,
        machTimebaseDenominator: 1 };
    }) }));
  const longestGap = Math.max(...frames.slice(1).map((ms, i) => ms - frames[i]));
  return { frames: directory, callbackStatus, displayLink, count: frames.length, limited: false, longestGap, layouts };
}

// A click recording: the window stays unchanged before the first click, between the clicks and after the last one is shown,
// so its longest gap is 452ms; each click is shown 30ms after it was asked for and its final state 8ms later.
test("a recording whose changes are each shown within the limit passes however long the window stays unchanged between them", (t) => {
  const stopped = stopReply(t, { frames: [0, 230, 238, 640, 648, 1100] });
  assert.equal(stopped.longestGap, 452);
  judgeShownChanges(stopped, [{ from: 200, to: 238 }, { from: 610, to: 648 }]);
});

// The main thread runs the callback of the refresh at 42ms only at 120ms: the main thread was busy.
test("a change that the application shows later than the limit fails as a defect of the application", (t) => {
  const stopped = stopReply(t, {
    frames: [0, 8, 16, 230],
    mainThread: [2, 10, 18, 26, 34, { at: 120, refresh: 42 }, 128, 136, 144, 152, 160, 168, 176, 184, 192, 200, 208, 216, 224],
    layouts: [{ ticket: 4, begun: 22, requested: 23, presented: 95, committed: 100.25 },
      { ticket: 5, begun: 101, requested: 102, presented: null, committed: 232 }],
  });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }], { what: "click" }), new RegExp("^Error: the application did " +
    "not show click 1 of 1 \\(asked at 20\\.0ms on the clock of the recording\\) without waiting longer than 100ms for a frame: " +
    "after 20\\.0ms the next frame was displayed 210ms later, at 230\\.0ms; in that time the check asked for 1 clicks, the host " +
    "began 2 layouts \\[4,5\\] and committed 1 \\[4 at 100\\.3ms\\], and the display link of the window was silent for longer " +
    "than two refreshes once: after its callback at 34\\.0ms the main thread ran the display-link callback 78\\.0ms after its " +
    "refresh, at 120\\.0ms \\(busy main thread\\); recording .*soksak-shown-changes-[^;]*; 1-minute load average \\d+\\.\\d\\d$"));
});

// The next callback after 34ms runs 0.5ms after its refresh at 119.5ms: no refresh came in between, whatever the main thread did.
test("a silence of the display link in which no refresh reached the window is told from a busy main thread", (t) => {
  const stopped = stopReply(t, { frames: [0, 8, 16, 230], mainThread: [2, 10, 18, 26, 34, 120, 128, 136, 224] });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }]), new RegExp("and committed 0 \\[\\], and the display link of " +
    "the window was silent for longer than two refreshes 2 times: after its callback at 34\\.0ms no display refresh reached the " +
    "window for 86ms \\(the display link received no vsync\\); after its callback at 136\\.0ms no display refresh reached the " +
    "window for 88ms \\(the display link received no vsync\\); recording "));
});

test("a display link that calls back at every refresh of the wait is named so", (t) => {
  const mainThread = Array.from({ length: 28 }, (_, i) => 2 + 8 * i);
  const stopped = stopReply(t, { frames: [0, 8, 16, 230], mainThread });
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
  const stopped = stopReply(t, { frames: [0, 8, 16, 230], mainThread });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }]), new RegExp("and the display link of the window called back " +
    "at every refresh of it, and no part of the window showed \\(NSWindow occlusion\\) at 25 of its 25 display-link callbacks " +
    "in that time, the first at 26\\.0ms, with in front of it, as read at 18\\.0ms: \\[Cover \\(pid 300, window 9, level 0\\) " +
    "at 200,30 1400x900, Self \\(pid 100, window 12, level 3\\) at 400,100 50x20\\]; recording "));
});

test("a covered wait whose recording read no windows in front of the window says so", (t) => {
  const mainThread = Array.from({ length: 28 }, (_, i) => ({ at: 2 + 8 * i, occluded: i >= 4 }));
  const stopped = stopReply(t, { frames: [0, 8, 16, 230], mainThread });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }]), new RegExp("at 24 of its 25 display-link callbacks in that " +
    "time, the first at 34\\.0ms, and the recording read no list of the windows in front of it; recording "));
});

test("a covered wait in which the window server listed no window in front of the window says so", (t) => {
  const mainThread = Array.from({ length: 28 }, (_, i) => ({ at: 2 + 8 * i, occluded: i >= 4, ...(i === 4 ? { inFront: [] } : {}) }));
  const stopped = stopReply(t, { frames: [0, 8, 16, 230], mainThread });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }]), new RegExp("the first at 34\\.0ms, with in front of it, as " +
    "read at 34\\.0ms: no window; recording "));
});

test("a wait in which the window showed at every display-link callback names no covered callback", (t) => {
  const mainThread = Array.from({ length: 28 }, (_, i) => 2 + 8 * i);
  const stopped = stopReply(t, { frames: [0, 8, 16, 230], mainThread });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }]), (error) => !/no part of the window showed/.test(error.message));
});

// The judgment of a wait stands on the premise that the window showed: a failing wait in which the display link found the window
// covered at a callback is not judged (NotJudged), and one in which the window showed at every callback fails
// (docs/spec/diagnostics.md#judgments-of-a-covered-window).
const cover = [{ number: 9, owner: "Cover", pid: 300, layer: 0, x: 200, y: 30, width: 1400, height: 900 }];

test("a failing wait in which the window was covered at a display-link callback is not judged and names the owners in front", (t) => {
  const mainThread = Array.from({ length: 28 }, (_, i) => ({ at: 2 + 8 * i, occluded: i === 10, ...(i === 10 ? { inFront: cover } : {}) }));
  const stopped = stopReply(t, { frames: [0, 8, 16, 230], mainThread });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }], { what: "click" }), (error) => error instanceof NotJudged
    && error.code === NOT_JUDGED && JSON.stringify(error.owners) === JSON.stringify(["Cover (pid 300)"])
    && error.span.at === 20 && error.span.end === 230
    && /^not judged: click 1 of 1: the window was covered at 1 of its 25 display-link callbacks from 20\.0ms to 230\.0ms, in front of it Cover \(pid 300\); the judgment over that span would have failed: the application did not show click 1 of 1 /.test(error.message));
});

test("a failing wait in which the window showed at every display-link callback fails and is not a judgment that was not made", (t) => {
  const mainThread = Array.from({ length: 28 }, (_, i) => ({ at: 2 + 8 * i, occluded: false }));
  const stopped = stopReply(t, { frames: [0, 8, 16, 230], mainThread });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }]), (error) => !(error instanceof NotJudged)
    && error.code !== NOT_JUDGED && /^the application did not show change 1 of 1 /.test(error.message));
});

test("a window covered only outside the failing wait leaves the failure standing", (t) => {
  // The callbacks at 2 and 10 found the window covered; the wait runs from 20 to the frame at 230.
  const mainThread = Array.from({ length: 28 }, (_, i) => ({ at: 2 + 8 * i, occluded: i < 2, ...(i === 0 ? { inFront: cover } : {}) }));
  const stopped = stopReply(t, { frames: [0, 8, 16, 230], mainThread });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }]), (error) => !(error instanceof NotJudged)
    && /^the application did not show change 1 of 1 /.test(error.message));
});

test("a failing wait of a recording without a display-link observation fails", (t) => {
  const stopped = { ...stopReply(t, { frames: [0, 8, 16, 230] }), displayLink: undefined };
  assert.throws(() => judgeShownChanges(stopped, [{ from: 20 }]), (error) => !(error instanceof NotJudged)
    && /the display-link observation of the main thread is missing from the stop reply/.test(error.message));
});

test("a judgment of a span that fails while the window was covered in that span is not judged", async (t) => {
  const mainThread = Array.from({ length: 28 }, (_, i) => ({ at: 2 + 8 * i, occluded: i >= 20, ...(i === 20 ? { inFront: cover } : {}) }));
  const { frames } = stopReply(t, { frames: [0, 8, 16, 230], mainThread });
  await assert.rejects(judgedWhileShown(frames, { spans: [{ at: 100, end: Infinity }], what: "the first screen" }, () => assert.fail("the frame shows no card")),
    (error) => error instanceof NotJudged && error.code === NOT_JUDGED && /^not judged: the first screen: the window was covered at 8 of its 15 display-link callbacks from 100\.0ms to the end of the recording, in front of it Cover \(pid 300\); the judgment over that span would have failed: the frame shows no card$/.test(error.message));
});

test("a judgment of a span that fails while the window showed at every callback of that span fails", async (t) => {
  const mainThread = Array.from({ length: 28 }, (_, i) => ({ at: 2 + 8 * i, occluded: i >= 20 }));
  const { frames } = stopReply(t, { frames: [0, 8, 16, 230], mainThread });
  await assert.rejects(judgedWhileShown(frames, { spans: [{ at: 0, end: 150 }], what: "the first screen" }, () => assert.fail("the frame shows no card")),
    (error) => !(error instanceof NotJudged) && error.message === "the frame shows no card");
});

test("a judgment of several spans fails when the window showed at every callback of one of them", async (t) => {
  // The window was covered from 162ms on: the span from 170ms is covered, the span from 20 to 60ms is not.
  const mainThread = Array.from({ length: 28 }, (_, i) => ({ at: 2 + 8 * i, occluded: i >= 20, ...(i === 20 ? { inFront: cover } : {}) }));
  const { frames } = stopReply(t, { frames: [0, 8, 16, 230], mainThread });
  await assert.rejects(judgedWhileShown(frames, { spans: [{ at: 20, end: 60 }, { at: 170, end: 200 }], what: "displayed states" },
    () => assert.fail("two states are missing")), (error) => !(error instanceof NotJudged) && error.message === "two states are missing");
  await assert.rejects(judgedWhileShown(frames, { spans: [{ at: 165, end: 180 }, { at: 190, end: 210 }], what: "displayed states" },
    () => assert.fail("two states are missing")), (error) => error instanceof NotJudged && error.span.at === 165 && error.span.end === 210
    && /covered at 4 of its 4 display-link callbacks from 165\.0ms to 210\.0ms, in front of it Cover \(pid 300\)/.test(error.message));
});

test("a judgment of a span that passes returns its value whatever covered the window", async (t) => {
  const mainThread = Array.from({ length: 28 }, (_, i) => ({ at: 2 + 8 * i, occluded: true }));
  const { frames } = stopReply(t, { frames: [0, 8, 16, 230], mainThread });
  assert.equal(await judgedWhileShown(frames, { spans: [{ at: 0, end: Infinity }], what: "the first screen" }, () => 7), 7);
});

// The layouts of a drag come with its reply and not with the stop reply, so the recording keeps those that it was judged by.
test("a judged recording keeps the layouts that it was judged by", (t) => {
  const layouts = [{ ticket: 9, begun: 3, requested: 4, presented: 6, committed: 7 }];
  const stopped = stopReply(t, { frames: [0, 8, 16], layouts: [] });
  judgeShownChanges(stopped, [{ from: 2 }], { layouts });
  assert.deepEqual(JSON.parse(readFileSync(join(stopped.frames, "layouts.json"), "utf8")), { layouts });
  const failed = stopReply(t, { frames: [0, 300], layouts });
  assert.throws(() => judgeShownChanges(failed, [{ from: 2 }]));
  assert.deepEqual(JSON.parse(readFileSync(join(failed.frames, "layouts.json"), "utf8")), { layouts });
});

// A transition that the window shows through several frames: its first frame comes 20ms after the request, and then the
// window waits 150ms before the frame that shows the final state.
test("a change shown through several frames fails when a frame of it comes later than the limit after the frame before it", (t) => {
  const stopped = stopReply(t, { frames: [0, 120, 128, 278, 286, 900] });
  judgeShownChanges(stopped, [{ from: 100, to: 128 }]);
  assert.throws(() => judgeShownChanges(stopped, [{ from: 100, to: 286 }], { what: "full screen click" }), new RegExp(
    "^Error: the application did not show full screen click 1 of 1 \\(asked at 100\\.0ms, its final state displayed at " +
    "286\\.0ms on the clock of the recording\\) without waiting longer than 100ms for a frame: after 128\\.0ms the next frame " +
    "was displayed 150ms later, at 278\\.0ms;"));
});

test("a change whose final state the recording does not reach fails", (t) => {
  const stopped = stopReply(t, { frames: [0, 120] });
  assert.throws(() => judgeShownChanges(stopped, [{ from: 100, to: 200 }]),
    /without waiting longer than 100ms for a frame: the recording has no frame after 120\.0ms;/);
});

test("a recording judged without the times of its changes fails", (t) => {
  const stopped = stopReply(t, { frames: [0, 8] });
  for (const owed of [undefined, null, [{ from: Number.NaN }], [{ from: 1, to: "2" }], [5]]) {
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

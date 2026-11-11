import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { drag, finishSession, Session } from "../app.mjs";

/**
 * A connection that imitates a host with one recording. stop takes the recording and then fails when stopFails is set.
 * Without a recording, it rejects with `no capture is running` like the host.
 */
function fakeClient(directory, { stopFails = false, removeFramesOnStopFailure = false,
  missingCallbackStatus = false, framePath = (path) => path } = {}) {
  const requests = [];
  let running = null;
  const captures = join(directory, "logs", "captures");
  mkdirSync(captures, { recursive: true });
  writeFileSync(join(directory, "logs", "host-1-1.jsonl"),
    `${JSON.stringify({ ts_us: 1791000000000000, seq: 1, level: "info", layer: "host", event: "log.open", fields: { schema: 3 } })}\n`);
  return {
    endpoint: { pid: process.pid },
    requests,
    request: async (method, params) => {
      requests.push({ method, ...params });
      // A recording holds the covered drawing of its window until it stops.
      if (method === "diagnostics.window.draw-covered") return null;
      if (method === "diagnostics.capture.start") {
        running = join(captures, `capture-${requests.length}`);
        mkdirSync(running);
        return { frames: framePath(running) };
      }
      if (method === "diagnostics.capture.stop") {
        if (!running) throw new Error("no capture is running");
        const frames = framePath(running);
        const storedFrames = running;
        running = null;
        if (stopFails) {
          if (removeFramesOnStopFailure) rmSync(storedFrames, { recursive: true, force: true });
          throw new Error("layout trace failed");
        }
        const callbackStatus = join(frames, "callback-status.jsonl");
        if (!missingCallbackStatus) writeFileSync(join(storedFrames, "callback-status.jsonl"), "{\"sequence\":1,\"status\":0,\"displayTime\":\"123\"}\n");
        return { frames, callbackStatus, count: 2, limited: false, longestGap: 16,
          layouts: [{ ticket: 3, begun: 1, requested: 2, presented: 3, committed: 4 }] };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

const app = { name: "fixture" };
const stops = (client) => client.requests.filter((request) => request.method === "diagnostics.capture.stop");
const newSession = (directory, client) => {
  const s = new Session({ ...app, configDir: directory }, client);
  s.recordingsBefore = [];
  s.eventStart = {};
  s.eventBoot = 0;
  s.markTest = async () => null;
  return s;
};
const cleanUp = async (s) => finishSession({ name: "recording test", passed: true, diagnostic() {} }, s, () => {});

test("a recording whose stop fails fails finalization, sends no second stop and preserves its folder", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory, { stopFails: true });
  const s = newSession(directory, client);
  const recording = await s.record({ display: true });
  assert.equal(client.requests.find((request) => request.method === "diagnostics.capture.start").display, true);
  await assert.rejects(recording.stop({ after: 5 }), /layout trace failed/);
  await assert.rejects(cleanUp(s), /1 recording failed: .*layout trace failed/);
  assert.equal(stops(client).length, 1, "the cleanup sent another stop after one was sent");
  assert.equal(existsSync(recording.frames), true, "the failed recording folder was not preserved");
});

test("a stop failure remains visible when the host removes its recording folder", { timeout: 30000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-removed-after-stop-error-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory, { stopFails: true, removeFramesOnStopFailure: true });
  const s = newSession(directory, client);
  const recording = await s.record();
  const identity = realpathSync(recording.frames);
  let stopError;
  try {
    await recording.stop({ after: 0 });
  } catch (error) {
    stopError = error;
  }
  await cleanUp(s);

  assert.match(stopError?.message ?? "", /layout trace failed/);
  assert.equal(s.failedRecordings.get(identity), stopError,
    "the stop error was not recorded under the identity captured when recording started");
  assert.equal(stops(client).length, 1, "cleanup retried stop after the host removed the folder");
  assert.equal(existsSync(recording.frames), false, "the host fixture did not remove the recording folder");
});

test("a recording that the check did not stop is stopped and removed after finalization", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory);
  const s = newSession(directory, client);
  const recording = await s.record();
  await cleanUp(s);
  assert.deepEqual(stops(client).map(({ after }) => after), [0]);
  assert.equal(existsSync(recording.frames), false, "the recording folder stayed");
});

test("a stopped recording is removed after finalization without another stop", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory);
  const s = newSession(directory, client);
  const recording = await s.record();
  const stopped = await recording.stop({ after: 7 });
  assert.equal(stopped.count, 2);
  assert.equal(stopped.callbackStatus, join(recording.frames, "callback-status.jsonl"));
  await assert.rejects(recording.stop({ after: 8 }), /stop was already sent/);
  await cleanUp(s);
  assert.equal(stops(client).length, 1);
  assert.equal(existsSync(recording.frames), false, "the recording folder stayed");
});

test("a tracked recording is finalized when its frame path has an equivalent filesystem spelling", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-path-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory);
  const s = newSession(directory, client);
  const captures = join(directory, "logs", "captures");
  const frames = join(captures, "capture-alias");
  mkdirSync(frames);
  writeFileSync(join(frames, "frame-0001.bgra"), "capture evidence");
  s.trackRecording(`${captures}/./capture-alias`);

  await cleanUp(s);
  assert.equal(existsSync(frames), false, "the tracked recording was not removed after successful finalization");
});

test("a failed stop remains failed when its frame path uses an equivalent filesystem spelling", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-failed-path-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const framePath = (path) => `${path.slice(0, path.lastIndexOf("/"))}/./${path.slice(path.lastIndexOf("/") + 1)}`;
  const client = fakeClient(directory, { stopFails: true, framePath });
  const s = newSession(directory, client);
  const recording = await s.record();
  await assert.rejects(recording.stop(), /layout trace failed/);

  await assert.rejects(cleanUp(s), /1 recording failed: .*layout trace failed/);
  assert.equal(existsSync(recording.frames), true, "the failed recording was removed during finalization");
});

test("finalization tolerates a tracked recording folder already removed", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-removed-path-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory);
  const s = newSession(directory, client);
  const frames = join(directory, "logs", "captures", "already-removed");
  mkdirSync(frames);
  s.trackRecording(frames);
  rmSync(frames, { recursive: true, force: true });

  await cleanUp(s);
  assert.equal(existsSync(frames), false);
});

// A failed check keeps its recording, and the recording holds what the check judged: the whole stop reply with every layout
// transaction, and the values that the check keeps beside it.
test("a stopped recording keeps its stop reply and the values that the check keeps", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory);
  const s = newSession(directory, client);
  const recording = await s.record();
  const stopped = await recording.stop({ after: 7 });
  assert.deepEqual(JSON.parse(readFileSync(join(recording.frames, "stop.json"), "utf8")), stopped);
  recording.keep("poses", [{ displayed: 12.5, at: 40 }]);
  assert.deepEqual(JSON.parse(readFileSync(join(recording.frames, "poses.json"), "utf8")), [{ displayed: 12.5, at: 40 }]);
  assert.throws(() => recording.keep("../poses", []), /a kept value needs a plain name/);
  await cleanUp(s);
  assert.equal(existsSync(recording.frames), false, "the recording of a passed check stayed");
});

test("a recording stop requires its callback status artifact", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory, { missingCallbackStatus: true });
  const s = newSession(directory, client);
  const recording = await s.record();
  await assert.rejects(recording.stop(), /callback status artifact is missing or has the wrong path/);
  await assert.rejects(cleanUp(s), /1 recording failed: .*callback status artifact is missing/);
  assert.equal(existsSync(recording.frames), true, "the recording with an invalid stop reply was not preserved");
});

test("a captured drag remains available when the session fails", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-drag-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory);
  const s = newSession(directory, client);
  const frames = join(directory, "logs", "captures", "drag-1");
  mkdirSync(frames);
  writeFileSync(join(frames, "callback-status.jsonl"), frameLines([0, 16]));
  s.get = async () => ({ active: false, occluded: false });
  s.presented = async () => ({ displayed: 12 });
  s.request = async (method) => {
    if (method === "diagnostics.window.draw-covered") return null;
    if (method === "diagnostics.drag") return { frames, took: 100, asked: 100, ticks: [4, 12], layouts: [] };
    if (method === "diagnostics.capture.stop") return { frames, callbackStatus: join(frames, "callback-status.jsonl"),
      count: 1, limited: false, longestGap: 16 };
    throw new Error(`unexpected ${method}`);
  };
  const result = await drag(s,
    { axis: "x", line: 0, dx: 10, dy: 0, ms: 100, times: 1 }, { capture: true });
  assert.equal(result.frameDir, frames);
  assert.equal(s.recordings.has(realpathSync(frames)), true, "the drag capture was not registered with the session");
  await finishSession({ name: "failed drag", passed: false, diagnostic() {} }, s, () => {});
  assert.equal(existsSync(frames), true, "the failed drag capture was removed before session finalization");
});

test("a capture is preserved when the final application error audit fails", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-audit-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory);
  const s = newSession(directory, client);
  const recording = await s.record();
  await recording.stop();
  appendFileSync(join(directory, "logs", "host-1-1.jsonl"),
    `${JSON.stringify({ ts_us: 1791000000000001, seq: 2, level: "error", layer: "host", event: "host.test.failed", fields: {} })}\n`);
  await assert.rejects(
    finishSession({ name: "audit failure", passed: true, diagnostic() {} }, s, () => {}),
    /application logged 1 error/,
  );
  assert.equal(existsSync(recording.frames), true, "the recording was removed before the final error audit");
});

/**
 * The callback status lines of complete frames displayed at `times` (ms), on a timebase of nanoseconds, as the recorder writes
 * them for a window stream.
 */
const frameLines = (times) => times.map((ms, index) => JSON.stringify({ sequence: index + 1, status: 0,
  frame: `frame-${index + 1}.bgra`, displayTime: String(Math.round(ms * 1e6)), machTimebaseNumerator: 1,
  machTimebaseDenominator: 1 })).join("\n") + "\n";

/**
 * A session whose captured drag sends its steps at `ticks` and stops with complete frames displayed at `frames`, the layouts
 * `layouts` of the drag and display-link callbacks of the main thread at `mainThread`, all in ms on the clock of the recording.
 * The stop reports the longest display interval of the frames as the host does.
 */
function gapSession(t, { frames: times, ticks, layouts = [], mainThread = [] }) {
  const directory = mkdtempSync(join(tmpdir(), "soksak-drag-gap-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const s = newSession(directory, fakeClient(directory));
  const frames = join(directory, "logs", "captures", "drag-1");
  mkdirSync(frames);
  const callbackStatus = join(frames, "callback-status.jsonl");
  writeFileSync(callbackStatus, frameLines(times));
  const displayLink = join(frames, "display-link.json");
  writeFileSync(displayLink, JSON.stringify({ state: "available", reason: "", omittedObservations: 0,
    observations: mainThread.map((ms, index) => ({ sequence: index + 1, callbackTime: String(Math.round(ms * 1e6)),
      machTimebaseNumerator: 1, machTimebaseDenominator: 1 })) }));
  const longestGap = Math.max(...times.slice(1).map((ms, i) => ms - times[i]));
  s.get = async () => ({ active: false, occluded: false });
  s.presented = async () => ({ displayed: times.at(-1) });
  s.request = async (method) => {
    if (method === "diagnostics.window.draw-covered") return null;
    if (method === "diagnostics.drag") return { frames, took: 100, asked: 100, ticks, layouts };
    if (method === "diagnostics.capture.stop") {
      return { frames, callbackStatus, displayLink, count: times.length, limited: false, longestGap, layouts: [] };
    }
    throw new Error(`unexpected ${method}`);
  };
  return s;
}

const gapPlan = { axis: "y", line: 1, dx: 0, dy: 10, ms: 100, times: 1 };

/** The times from `from` to `to` (ms) every `step` ms. */
const every = (from, to, step) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

// ScreenCaptureKit delivers no callback for a window that stays as it is, so the recording of a drag has no frames before the
// first step, between the release of a round trip and the next press, and after the display of the last step, however long
// those times are. The drag owes a frame only to its steps.
test("a drag whose window stays unchanged before its first step, between its round trips and after its last step passes", async (t) => {
  const s = gapSession(t, {
    frames: [0, ...every(150, 246, 8), ...every(400, 496, 8), 880],
    ticks: [...every(152, 244, 8), ...every(402, 494, 8)],
  });
  const result = await drag(s, gapPlan, { capture: true });
  assert.equal(result.longestGap, 384);
});

test("a drag step that waits longer than the limit for a frame fails and names what the host did in that time", async (t) => {
  const s = gapSession(t, {
    frames: [...every(0, 96, 8), ...every(260, 308, 8)],
    ticks: every(4, 300, 8),
    layouts: [{ ticket: 6, begun: 40, committed: 50 }, { ticket: 7, begun: 120, committed: 150 }, { ticket: 8, begun: 200, committed: null }],
    mainThread: [...every(2, 114, 8), ...every(234, 306, 8)],
  });
  await assert.rejects(drag(s, gapPlan, { capture: true }), new RegExp("^Error: the application did not show drag step 13 of 38, " +
    "asked at 100\\.0ms on the clock of the recording, within 100ms: the next frame was displayed 160ms later, at 260\\.0ms; " +
    "in that time the check asked for 20 drag steps, the host began 2 layouts \\[7,8\\] and committed 1 \\[7\\], and the " +
    "main thread of the host ran no display-link callback for 120ms of it; recording .*drag-1; 1-minute load average " +
    "\\d+\\.\\d\\d$"));
});

test("a drag step after the last recorded frame fails", async (t) => {
  const s = gapSession(t, { frames: every(0, 96, 8), ticks: every(4, 100, 8) });
  await assert.rejects(drag(s, gapPlan, { capture: true }),
    /^Error: the application did not show drag step 13 of 13, asked at 100\.0ms on the clock of the recording, within 100ms: the recording has no frame after it;/);
});

test("a captured drag whose reply has no step times fails", async (t) => {
  const s = gapSession(t, { frames: every(0, 96, 8), ticks: undefined });
  await assert.rejects(drag(s, gapPlan, { capture: true }),
    /^Error: the recording has no times of the changes that it shows \(drag step times undefined\), so its frames cannot be judged against them$/);
});

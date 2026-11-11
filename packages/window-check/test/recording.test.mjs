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
  writeFileSync(join(frames, "callback-status.jsonl"), "{}\n");
  s.get = async () => ({ active: false, occluded: false });
  s.presented = async () => ({ displayed: 12 });
  s.request = async (method) => {
    if (method === "diagnostics.window.draw-covered") return null;
    if (method === "diagnostics.drag") return { frames, took: 100, asked: 100 };
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
 * A session whose captured drag stops with `longestGap` and the callback status lines `lines`: each is [status, display time in
 * ms], on a timebase of nanoseconds.
 */
function gapSession(t, longestGap, lines) {
  const directory = mkdtempSync(join(tmpdir(), "soksak-drag-gap-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const s = newSession(directory, fakeClient(directory));
  const frames = join(directory, "logs", "captures", "drag-1");
  mkdirSync(frames);
  const callbackStatus = join(frames, "callback-status.jsonl");
  writeFileSync(callbackStatus, lines.map(([status, ms], index) => JSON.stringify({ sequence: index + 1, status,
    frame: status === 0 ? `frame-${index + 1}.bgra` : null, displayTime: String(ms * 1e6),
    machTimebaseNumerator: 1, machTimebaseDenominator: 1 })).join("\n") + "\n");
  s.get = async () => ({ active: false, occluded: false });
  s.presented = async () => ({ displayed: 12 });
  s.request = async (method) => {
    if (method === "diagnostics.window.draw-covered") return null;
    if (method === "diagnostics.drag") return { frames, took: 100, asked: 100 };
    if (method === "diagnostics.capture.stop") return { frames, callbackStatus, count: 3, limited: false, longestGap };
    throw new Error(`unexpected ${method}`);
  };
  return s;
}

const gapPlan = { axis: "y", line: 1, dx: 0, dy: 10, ms: 100, times: 1 };

test("a drag whose window presented nothing new for longer than the limit fails and says the recorder saw it unchanged", async (t) => {
  const s = gapSession(t, 131, [[0, 0], [0, 16], [1, 32], [1, 48], [1, 64], [1, 80], [1, 96], [1, 112], [1, 128], [0, 147], [0, 163]]);
  await assert.rejects(drag(s, gapPlan, { capture: true }),
    /^Error: the window presented nothing new for 131ms \(the recorder saw it unchanged\); a drag changes the screen with every frame, so a presentation more than 100ms apart fails; 1-minute load average \d+\.\d\d$/);
});

test("a drag whose recording missed more than the limit fails and says the frames were not recorded", async (t) => {
  const s = gapSession(t, 131, [[0, 0], [0, 16], [1, 32], [0, 147], [0, 163]]);
  await assert.rejects(drag(s, gapPlan, { capture: true }),
    /^Error: the recording has a 131ms gap between frames; frames longer than 100ms apart were not recorded, so this run did not measure the whole gesture; 1-minute load average \d+\.\d\d$/);
});

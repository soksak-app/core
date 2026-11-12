import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { drag, finishSession, Session } from "../app.mjs";
import { writeStillRecording } from "./still-recording.mjs";

/**
 * A connection that imitates a host with one recording on a display of `refreshRate` Hz. The recording plans the stills that
 * its start asks for (frames, or seconds at gap), and its stop writes the first two of them and stops the rest of the plan.
 * stop takes the recording and then fails when stopFails is set. Without a recording, it rejects with `no capture is running`
 * like the host. `damage` changes the stop reply and the stills.jsonl of the recording after it is written.
 */
function fakeClient(directory, { stopFails = false, removeFramesOnStopFailure = false, refreshRate = 120,
  damage = (reply) => reply, framePath = (path) => path } = {}) {
  const requests = [];
  let running = null;
  let plan = null;
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
      if (method === "status.get" && params.name === "host.window") return { refreshRate };
      if (method === "diagnostics.capture.start") {
        plan = { gap: params.gap, stills: params.frames ?? Math.ceil(params.seconds * 1000 / params.gap) };
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
        const reply = writeStillRecording(storedFrames, { gap: plan.gap, until: (plan.stills - 1) * plan.gap, changes: [0],
          stoppedAt: 2, layouts: [{ ticket: 3, begun: 1, requested: 2, presented: 3, committed: 4 }] });
        return damage({ ...reply, frames, stills: join(frames, "stills.jsonl") }, storedFrames);
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
  assert.equal(stopped.stills, join(recording.frames, "stills.jsonl"));
  await assert.rejects(recording.stop({ after: 8 }), /stop was already sent/);
  await cleanUp(s);
  assert.equal(stops(client).length, 1);
  assert.equal(existsSync(recording.frames), false, "the recording folder stayed");
});

// A recording takes one still each refresh of the display of its window, read when it starts, and plans as many stills as a
// recording holds, so it records until the check stops it. The check may ask for its own gap and length.
test("a recording asks for one still each refresh of the display of its window and the most stills a recording holds", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-gap-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [refreshRate, gap] of [[120, 1000 / 120], [60, 1000 / 60]]) {
    const client = fakeClient(directory, { refreshRate });
    const s = newSession(directory, client);
    await (await s.record({ display: true })).stop();
    assert.deepEqual(client.requests.find((request) => request.method === "diagnostics.capture.start"),
      { method: "diagnostics.capture.start", window: "main", display: true, gap, frames: 4096 });
    await cleanUp(s);
  }
  const client = fakeClient(directory);
  const s = newSession(directory, client);
  await (await s.record({ gap: 20, seconds: 2 })).stop();
  assert.deepEqual(client.requests.find((request) => request.method === "diagnostics.capture.start"),
    { method: "diagnostics.capture.start", window: "main", gap: 20, seconds: 2 });
  assert.equal(client.requests.some((request) => request.method === "status.get"), false,
    "a recording with its own gap read the refresh rate");
  await cleanUp(s);
});

test("a recording of a window on no display fails before it starts", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-no-display-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory, { refreshRate: null });
  const s = newSession(directory, client);
  await assert.rejects(s.record(), /^Error: a recording takes one still each refresh, and host\.window\.refreshRate is null$/);
  assert.equal(client.requests.some((request) => request.method === "diagnostics.capture.start"), false);
  await cleanUp(s);
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

// The stop of a recording checks the still recording that the host wrote: one stills.jsonl row for each planned still, every
// planned still written or counted as missed, and the frame file of each written still.
for (const [what, damage, error] of [
  ["without its stills.jsonl", (reply, stored) => { rmSync(join(stored, "stills.jsonl")); return reply; },
    /the still recording .*stills\.jsonl is missing/],
  ["whose stills path is another file", (reply) => ({ ...reply, stills: join(reply.frames, "stills-other.jsonl") }),
    /the stop reply names the stills .*stills-other\.jsonl, not .*stills\.jsonl/],
  ["with fewer rows than planned stills", (reply, stored) => {
    const path = join(stored, "stills.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").split("\n").slice(0, 100).join("\n") + "\n");
    return reply;
  }, /the still recording .* has 100 rows for a plan of 4096 stills/],
  ["whose count and missed stills do not make the plan", (reply) => ({ ...reply, missed: reply.missed - 1 }),
    /the still recording .* counts 2 written and 4093 missed stills for a plan of 4096 stills/],
  ["whose count is not its written rows", (reply) => ({ ...reply, count: 3, missed: 4093 }),
    /the still recording .* counts 3 written stills, and stills\.jsonl has 2 written rows/],
  ["whose rows leave the order of the plan", (reply, stored) => {
    const path = join(stored, "stills.jsonl");
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    [lines[5], lines[6]] = [lines[6], lines[5]];
    writeFileSync(path, lines.join("\n") + "\n");
    return reply;
  }, /the still recording .* has the row of still 6 at the place of still 5/],
  ["whose stills were taken at another gap", (reply, stored) => {
    const path = join(stored, "stills.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").replaceAll(`"requestedGap":${1000 / 120}`, '"requestedGap":16'));
    return reply;
  }, new RegExp(`the still recording .* took still 0 at a gap of 16ms, not the ${1000 / 120}ms that the recording asked for`)],
  ["without the frame of a written still", (reply, stored) => { rmSync(join(stored, "frame-0001.bgra")); return reply; },
    /the still recording .* has no frame-0001\.bgra for its written still 1/],
]) {
  test(`a recording stop ${what} fails and keeps the recording`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "soksak-record-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const client = fakeClient(directory, { damage });
    const s = newSession(directory, client);
    const recording = await s.record();
    await assert.rejects(recording.stop(), error);
    await assert.rejects(cleanUp(s), /1 recording failed: .*the st/);
    assert.equal(existsSync(recording.frames), true, "the recording with an invalid stop reply was not preserved");
  });
}

// A recording stopped after a time that its plan does not reach lost the screens of that time.
test("a recording whose plan ends before the time that it is stopped after fails", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-short-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const s = newSession(directory, fakeClient(directory));
  const recording = await s.record({ gap: 8, frames: 4 });
  await assert.rejects(recording.stop({ after: 100 }), new RegExp("^Error: the still recording .*stills\\.jsonl planned its " +
    "last still at 24\\.0ms, before 100\\.0ms, the time that it was stopped after$"));
  await assert.rejects(cleanUp(s), /1 recording failed/);
});

test("a captured drag remains available when the session fails", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-drag-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory);
  const s = newSession(directory, client);
  const frames = join(directory, "logs", "captures", "drag-1");
  const stopped = dragRecording(frames, { changes: [8, 16], until: 24 });
  s.get = async () => ({ active: false, occluded: false, refreshRate: 125 });
  s.presented = async () => ({ displayed: 16 });
  s.request = async (method) => {
    if (method === "diagnostics.window.draw-covered") return null;
    if (method === "diagnostics.drag") return { frames, took: 100, asked: 100, ticks: [4, 12], layouts: [] };
    if (method === "diagnostics.capture.stop") return stopped;
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
 * The still recording of a captured drag on a display of 125 Hz, as the host writes it: the 4096 stills that window-check asks
 * for at a gap of 8ms, those up to `until` (ms) taken 1ms each of a window that changes at `changes`, and the rest stopped.
 */
const dragRecording = (frames, { until, ...stills }) =>
  writeStillRecording(frames, { ...stills, gap: 8, until: 4095 * 8, stoppedAt: Math.floor(until / 8) + 1, took: 1 });

/**
 * A session whose captured drag sends its steps at `ticks` and stops with a still recording, taken until `until` (ms), of a
 * window that changes at `changes`, the layouts `layouts` of the drag and display-link callbacks of the main thread at
 * `mainThread`, all in ms on the clock of the recording. The last screen of the drag is displayed at its last change.
 */
function gapSession(t, { changes, until, ticks, layouts = [], mainThread = [] }) {
  const directory = mkdtempSync(join(tmpdir(), "soksak-drag-gap-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const s = newSession(directory, fakeClient(directory));
  const frames = join(directory, "logs", "captures", "drag-1");
  const stopped = dragRecording(frames, { changes, until, displayLink: { state: "available", reason: "", omittedObservations: 0,
    observations: mainThread.map((ms, index) => ({ sequence: index + 1, callbackTime: String(Math.round(ms * 1e6)),
      callbackMediaTime: ms / 1000, timestamp: (ms - 0.5) / 1000, targetTimestamp: (ms + 7.833) / 1000, duration: 0.008333,
      machTimebaseNumerator: 1, machTimebaseDenominator: 1 })) } });
  s.get = async () => ({ active: false, occluded: false, refreshRate: 125 });
  s.presented = async () => ({ displayed: changes.at(-1) });
  s.requests = [];
  s.request = async (method, params) => {
    s.requests.push({ method, ...params });
    if (method === "diagnostics.window.draw-covered") return null;
    if (method === "diagnostics.drag") return { frames, took: 100, asked: 100, ticks, layouts };
    if (method === "diagnostics.capture.stop") return stopped;
    throw new Error(`unexpected ${method}`);
  };
  return s;
}

const gapPlan = { axis: "y", line: 1, dx: 0, dy: 10, ms: 100, times: 1 };

/** The times from `from` to `to` (ms) every `step` ms. */
const every = (from, to, step) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

// A recording takes a still each refresh, also while the window stays as it is: before the first step, between the release of a
// round trip and the next press, and after the display of the last step. Those stills show no change, and the drag owes a
// change only to its steps. The drag asks for the recording that window-check plans: a still each refresh, 4096 stills.
test("a drag whose window stays unchanged before its first step, between its round trips and after its last step passes", async (t) => {
  const s = gapSession(t, {
    changes: [...every(150, 246, 8), ...every(400, 496, 8), 880],
    until: 900,
    ticks: [...every(152, 244, 8), ...every(402, 494, 8)],
  });
  const result = await drag(s, gapPlan, { capture: true });
  assert.deepEqual(s.requests.find((request) => request.method === "diagnostics.drag").capture, { gap: 8, frames: 4096 });
  assert.equal(result.count, 113);
  assert.equal(result.stills, join(result.frameDir, "stills.jsonl"));
});

test("a drag step that waits longer than the limit for a frame fails and names what the host did in that time", async (t) => {
  const s = gapSession(t, {
    changes: [...every(0, 96, 8), ...every(260, 308, 8)],
    until: 316,
    ticks: every(4, 300, 8),
    layouts: [{ ticket: 6, begun: 40, committed: 50 }, { ticket: 7, begun: 120, committed: 150 }, { ticket: 8, begun: 200, committed: null }],
    mainThread: [...every(2, 114, 8), ...every(234, 306, 8)],
  });
  await assert.rejects(drag(s, gapPlan, { capture: true }), new RegExp("^Error: the application did not show drag step 13 of 38 " +
    "\\(asked at 100\\.0ms on the clock of the recording\\) without waiting longer than 100ms for a frame: after 100\\.0ms the " +
    "first still that shows a change completed 165ms later, at 265\\.0ms \\(requested at 264\\.0ms\\); " +
    "in that time the check asked for 21 drag steps, the host began 2 layouts \\[7,8\\] and committed 1 \\[7 at 150\\.0ms\\], and " +
    "the display link of the window was silent for longer than two refreshes once: after its callback at 114\\.0ms no display " +
    "refresh reached the window for 120ms \\(the display link received no vsync\\); recording .*drag-1; 1-minute load average " +
    "\\d+\\.\\d\\d$"));
});

test("a drag step after the last change that the recording shows fails", async (t) => {
  const s = gapSession(t, { changes: every(0, 96, 8), until: 104, ticks: every(4, 100, 8) });
  await assert.rejects(drag(s, gapPlan, { capture: true }),
    /^Error: the application did not show drag step 13 of 13 \(asked at 100\.0ms on the clock of the recording\) without waiting longer than 100ms for a frame: the recording shows no change after 100\.0ms;/);
});

test("a captured drag whose reply has no step times fails", async (t) => {
  const s = gapSession(t, { changes: every(0, 96, 8), until: 104, ticks: undefined });
  await assert.rejects(drag(s, gapPlan, { capture: true }),
    /^Error: the recording has no times of the changes that it shows \(drag step times undefined\), so its frames cannot be judged against them$/);
});

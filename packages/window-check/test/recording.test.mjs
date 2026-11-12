import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { drag, finishSession, Session } from "../app.mjs";
import { writeStillRecording } from "../still-recording.mjs";

/**
 * A connection that imitates a host with one recording on a display of `refreshRate` Hz. The recording plans the stills that
 * its start asks for (frames, or seconds at gap), and its stop writes the first two of them and stops the rest of the plan.
 * stop takes the recording and then fails when stopFails is set. Without a recording, it rejects with `no capture is running`
 * like the host. The start and stop replies name the recorded window 7, or null for a recording of the display, and the start
 * of a recording of a new window names none; `started` changes the start reply. The stills of `failed` fail. `damage` changes the stop reply and the stills.jsonl of the recording after it is written.
 */
function fakeClient(directory, { stopFails = false, removeFramesOnStopFailure = false, refreshRate = 120,
  damage = (reply) => reply, framePath = (path) => path, failed = [], started = (reply) => reply } = {}) {
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
        plan = { gap: params.gap, stills: params.frames ?? Math.ceil(params.seconds * 1000 / params.gap),
          window: params.display === true ? null : 7 };
        running = join(captures, `capture-${requests.length}`);
        mkdirSync(running);
        // A recording of a new window starts before the window is shown, so its start names no window.
        return started({ frames: framePath(running), window: params.newWindow === true ? null : plan.window });
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
        const reply = writeStillRecording(storedFrames, { gap: plan.gap, until: (plan.stills - 1) * plan.gap, stoppedAt: 2, failed, window: plan.window, layouts: [{ ticket: 3, begun: 1, requested: 2, presented: 3, committed: 4 }] });
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
const cleanUp = async (s, diagnostics = []) => finishSession({ name: "recording test", passed: true,
  diagnostic(line) { diagnostics.push(line); } }, s, () => {});

// A recording is the log of a check: a stop that fails is told, the check passes and removes the folder, and only the judgment
// of the recording fails on the stop.
test("a recording whose stop fails is told, sends no second stop and fails only its judgment", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory, { stopFails: true });
  const s = newSession(directory, client);
  const recording = await s.record({ display: true });
  assert.equal(client.requests.find((request) => request.method === "diagnostics.capture.start").display, true);
  assert.equal(await recording.stop({ after: 5 }), null);
  assert.throws(() => recording.judge(), /layout trace failed/);
  const diagnostics = [];
  await cleanUp(s, diagnostics);
  assert.ok(diagnostics.some((line) => /^recording: .*: the stop of the recording failed: layout trace failed$/.test(line)),
    `the stop failure was not told: ${diagnostics.join("; ")}`);
  assert.equal(stops(client).length, 1, "the cleanup sent another stop after one was sent");
  assert.equal(existsSync(recording.frames), false, "the recording of a passed check stayed");
});

test("a recording whose start fails is told, has no frames, answers no stop and fails only its judgment", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-start-fails-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory);
  const request = client.request;
  client.request = async (method, params) => {
    if (method === "diagnostics.capture.start") {
      client.requests.push({ method, ...params });
      throw new Error("the capture did not start");
    }
    return request(method, params);
  };
  const s = newSession(directory, client);
  const recording = await s.record();
  assert.equal(recording.frames, null);
  assert.equal(await recording.stop({ after: 0 }), null);
  recording.keep("poses", []);
  assert.throws(() => recording.judge(), /the capture did not start/);
  const diagnostics = [];
  await cleanUp(s, diagnostics);
  assert.ok(diagnostics.includes("recording: the recording did not start: the capture did not start"),
    `the start failure was not told: ${diagnostics.join("; ")}`);
  assert.deepEqual(stops(client), [], "a stop was sent for a recording that did not start");
  assert.deepEqual(client.requests.filter((request) => request.method === "diagnostics.window.draw-covered").map(({ draw }) => draw),
    [true, false], "the hold of the covered drawing was not ended");
});

test("a stop failure is told when the host removes its recording folder", { timeout: 30000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-removed-after-stop-error-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory, { stopFails: true, removeFramesOnStopFailure: true });
  const s = newSession(directory, client);
  const recording = await s.record();
  assert.equal(await recording.stop({ after: 0 }), null);
  const diagnostics = [];
  await cleanUp(s, diagnostics);

  assert.ok(diagnostics.some((line) => /the stop of the recording failed: layout trace failed$/.test(line)),
    `the stop failure was not told: ${diagnostics.join("; ")}`);
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

// A recording is the log of a check: a still that a recording which the check did not stop lost is told, and the check passes.
test("a recording that the check did not stop tells a still that it lost as a diagnostic", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory, { failed: [1] });
  const s = newSession(directory, client);
  const recording = await s.record();
  const diagnostics = [];
  await cleanUp(s, diagnostics);
  assert.ok(diagnostics.some((line) => /^recording: .*: the recording lost 1 stills of the recording that the check did not stop: still 1 planned at 8\.3ms failed/.test(line)),
    `the lost still was not told: ${diagnostics.join("; ")}`);
  assert.equal(existsSync(recording.frames), false, "the recording of a passed check stayed");
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

test("a recording of a window on no display is told and does not start", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-no-display-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory, { refreshRate: null });
  const s = newSession(directory, client);
  const recording = await s.record();
  assert.throws(() => recording.judge(), /^Error: a recording takes one still each refresh, and host\.window\.refreshRate is null$/);
  assert.equal(client.requests.some((request) => request.method === "diagnostics.capture.start"), false);
  assert.deepEqual(s.recordingNotes,
    ["the recording did not start: a recording takes one still each refresh, and host.window.refreshRate is null"]);
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

// The judgment of a recording checks the still recording that the host wrote: one stills.jsonl row for each planned still,
// every planned still written or counted as missed, and the frame file of each written still and of no other still. The stop
// tells what is wrong as a diagnostic of the check, and judge() fails on it.
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
  ["with a frame file of no written still", (reply, stored) => { writeFileSync(join(stored, "frame-0005.bgra"), ""); return reply; },
    /the still recording .* has frame-0005\.bgra, the frame file of no written still/],
  ["whose written still names a profile that the recording lacks", (reply, stored) => {
    for (const name of readdirSync(stored).filter((name) => name.endsWith(".icc"))) rmSync(join(stored, name));
    return reply;
  }, /the still recording .* has no color-[0-9a-f]{16}\.icc for its written still 0/],
  ["with a profile file of no still", (reply, stored) => { writeFileSync(join(stored, "color-0000000000000000.icc"), "x"); return reply; },
    /the still recording .* has color-0000000000000000\.icc, the colour profile of no still/],
  ["whose profile file is not the profile of its name", (reply, stored) => {
    for (const name of readdirSync(stored).filter((name) => name.endsWith(".icc"))) writeFileSync(join(stored, name), "another profile");
    return reply;
  }, /the still recording .* has color-[0-9a-f]{16}\.icc, whose SHA-256 begins with [0-9a-f]{16}/],
  ["that counts other late stills than its rows", (reply) => ({ ...reply, late: reply.late + 1 }),
    /the still recording .* counts 1 late stills, and stills\.jsonl has 0 late rows/],
  ["that names another longest gap than its rows", (reply) => ({ ...reply, longestGap: reply.longestGap + 0.000001 }),
    /the still recording .* names the longest gap 8\.33333399+ms, and the request times of its written stills have the longest gap 8\.333333ms/],
  ["that names another recorded window than its start", (reply) => ({ ...reply, window: 8 }),
    /the stop reply names the recorded window 8, not the window 7 that the recording records/],
  ["whose written still did not take the recorded window", (reply, stored) => {
    const path = join(stored, "stills.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").replace('"windows":[7]', '"windows":[9]'));
    return reply;
  }, /the still recording .* took still 0 of the windows \[9\], without the recorded window 7/],
]) {
  test(`a recording stop ${what} is told, and its judgment fails`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "soksak-record-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const client = fakeClient(directory, { damage });
    const s = newSession(directory, client);
    const recording = await s.record();
    await recording.stop();
    assert.throws(() => recording.judge(), error);
    const diagnostics = [];
    await cleanUp(s, diagnostics);
    const told = new RegExp(`^recording: ${recording.frames.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: ${error.source.replace(/^\^/, "")}`);
    assert.ok(diagnostics.some((line) => told.test(line)), `the stop did not tell ${error}: ${diagnostics.join("; ")}`);
  });
}

// A recording of a window names the window that it records (a window number), and a recording of the display names none
// (null): each written still of a window recording took that window.
test("a recording whose start names no recorded window is told, and its judgment fails", async (t) => {
  for (const [params, started, error] of [
    [{}, ({ frames }) => ({ frames }),
      /^Error: the start reply of a window recording names the recorded window undefined, not a window number$/],
    [{}, ({ frames }) => ({ frames, window: null }),
      /^Error: the start reply of a window recording names the recorded window null, not a window number$/],
    [{ display: true }, ({ frames }) => ({ frames, window: 7 }),
      /^Error: the start reply of a display recording names the recorded window 7, not null$/],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "soksak-record-window-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const s = newSession(directory, fakeClient(directory, { started }));
    const recording = await s.record(params);
    await recording.stop();
    assert.throws(() => recording.judge(), error);
    const diagnostics = [];
    await cleanUp(s, diagnostics);
    assert.ok(diagnostics.some((line) => line.startsWith(`recording: ${recording.frames}: the start reply of a `)),
      `the start was not told: ${diagnostics.join("; ")}`);
  }
});

// A recording of a new window starts before the application shows the window, so only its stop names the window.
test("a recording of a new window reads its window from its stop", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-new-window-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const s = newSession(directory, fakeClient(directory));
  const stopped = await (await s.record({ newWindow: true })).stop();
  assert.equal(stopped.window, 7);
  await cleanUp(s);
});

test("a recording of a new window whose start names a window or whose stop names none is told, and its judgment fails", async (t) => {
  for (const [started, damage, error] of [
    [({ frames }) => ({ frames, window: 7 }), (reply) => reply,
      /^Error: the start reply of a new window recording names the recorded window 7, not null$/],
    [(reply) => reply, (reply) => ({ ...reply, window: null }),
      /^Error: the stop reply of a window recording names the recorded window null, not a window number$/],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "soksak-record-new-window-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const s = newSession(directory, fakeClient(directory, { started, damage }));
    const recording = await s.record({ newWindow: true });
    await recording.stop();
    assert.throws(() => recording.judge(), error);
    const diagnostics = [];
    await cleanUp(s, diagnostics);
    assert.ok(diagnostics.some((line) => line.startsWith(`recording: ${recording.frames}: the `)), `nothing was told: ${diagnostics.join("; ")}`);
  }
});

test("a recording of the display takes no recorded window", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-display-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const s = newSession(directory, fakeClient(directory));
  const stopped = await (await s.record({ display: true })).stop();
  assert.equal(stopped.window, null);
  await cleanUp(s);
});

// A recording holds at most 4096 stills, so a reply for a larger plan is no reply of a recording.
test("the judgment of a recording stop for a plan of more stills than a recording holds fails", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-most-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const s = newSession(directory, fakeClient(directory));
  const recording = await s.record({ gap: 8, frames: 4097 });
  await recording.stop();
  assert.throws(() => recording.judge(), /the still recording .*stills\.jsonl plans 4097 stills, more than the 4096 that a recording holds$/);
  await cleanUp(s);
});

// A recording stopped after a time that its plan does not reach lost the screens of that time.
test("the judgment of a recording whose plan ends before the time that it is stopped after fails", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-short-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const s = newSession(directory, fakeClient(directory));
  const recording = await s.record({ gap: 8, frames: 4 });
  await recording.stop({ after: 100 });
  assert.throws(() => recording.judge(), new RegExp("^Error: the still recording .*stills\\.jsonl planned its " +
    "last still at 24\\.0ms, before 100\\.0ms, the time that it was stopped after$"));
  await cleanUp(s);
});

test("a captured drag remains available when the session fails", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-drag-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory);
  const s = newSession(directory, client);
  const frames = join(directory, "logs", "captures", "drag-1");
  const stopped = dragRecording(frames, { until: 24 });
  s.get = async () => ({ active: false, occluded: false, refreshRate: 125 });
  s.presented = async () => ({ displayed: 16 });
  s.request = async (method) => {
    if (method === "diagnostics.window.draw-covered") return null;
    if (method === "diagnostics.drag") return { frames, took: 100, asked: 100, ticks: [4, 12], layouts: [], window: 7 };
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
 * for at a gap of 8ms, those up to `until` (ms) taken 1ms each, and the rest stopped.
 */
const dragRecording = (frames, { until, ...stills }) =>
  writeStillRecording(frames, { ...stills, gap: 8, until: 4095 * 8, stoppedAt: Math.floor(until / 8) + 1, took: 1 });

/**
 * A session whose captured drag sends its steps at `ticks` and stops with a still recording taken until `until` (ms), with the
 * layouts `layouts` of the drag; the stills of `failed` fail, the drag reply names the recorded window `dragWindow` and the
 * stop names `window`. The last screen of the drag is displayed at `displayed`.
 */
function dragSession(t, { until, ticks, displayed = until, layouts = [], failed = [], window = 7, dragWindow = 7 }) {
  const directory = mkdtempSync(join(tmpdir(), "soksak-drag-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const s = newSession(directory, fakeClient(directory));
  const frames = join(directory, "logs", "captures", "drag-1");
  const stopped = dragRecording(frames, { until, failed, window });
  s.get = async () => ({ active: false, occluded: false, refreshRate: 125 });
  s.presented = async () => ({ displayed });
  s.requests = [];
  s.request = async (method, params) => {
    s.requests.push({ method, ...params });
    if (method === "diagnostics.window.draw-covered") return null;
    if (method === "diagnostics.drag") return { frames, took: 100, asked: 100, ticks, layouts, window: dragWindow };
    if (method === "diagnostics.capture.stop") return stopped;
    throw new Error(`unexpected ${method}`);
  };
  return s;
}

const gapPlan = { axis: "y", line: 1, dx: 0, dy: 10, ms: 100, times: 1 };

/** The times from `from` to `to` (ms) every `step` ms. */
const every = (from, to, step) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

// A recording takes a still each refresh, also while the window stays as it is. The drag asks for the recording that
// window-check plans, a still each refresh and 4096 stills, and returns its counts.
test("a captured drag asks for the recording that window-check plans and returns its counts", async (t) => {
  const s = dragSession(t, { until: 900, displayed: 880, ticks: [...every(152, 244, 8), ...every(402, 494, 8)] });
  const result = await drag(s, gapPlan, { capture: true });
  assert.deepEqual(s.requests.find((request) => request.method === "diagnostics.drag").capture, { gap: 8, frames: 4096 });
  assert.equal(result.count, 113);
  // Each still up to the stop is written, so the longest gap is one gap of 8ms.
  assert.equal(result.longestGap, 8);
  assert.equal(result.stills, join(result.frameDir, "stills.jsonl"));
  assert.deepEqual(s.recordingNotes, []);
});

// The recording of a drag is its log: a still that it lost and a recorded window that its replies do not agree on are told, and
// the drag does not fail on them.
test("a captured drag whose recording lost a still tells it", async (t) => {
  const s = dragSession(t, { until: 104, ticks: every(4, 92, 8), failed: [5] });
  await drag(s, gapPlan, { capture: true });
  assert.equal(s.recordingNotes.length, 1);
  assert.match(s.recordingNotes[0],
    /: the recording lost 1 stills of the drag: still 5 planned at 40\.0ms failed \(the window server returned no image\)$/);
});

test("a captured drag whose stop fails tells it and returns the drag", async (t) => {
  const s = dragSession(t, { until: 104, ticks: every(4, 92, 8) });
  const request = s.request;
  s.request = async (method, params) => {
    if (method === "diagnostics.capture.stop") throw new Error("the capture failed");
    return request(method, params);
  };
  const result = await drag(s, gapPlan, { capture: true });
  assert.equal(result.took, 100);
  assert.equal(result.count, undefined);
  assert.deepEqual(s.recordingNotes.map((note) => note.replace(/^.*: the stop/, "the stop")),
    ["the stop of the recording of the drag failed: the capture failed"]);
});

test("a captured drag of a window on no display runs without a recording and tells it", async (t) => {
  const s = dragSession(t, { until: 104, ticks: every(4, 92, 8) });
  s.get = async () => ({ active: false, occluded: false, refreshRate: null });
  const result = await drag(s, gapPlan, { capture: true });
  assert.equal(s.requests.find((request) => request.method === "diagnostics.drag").capture, false);
  assert.equal(s.requests.some((request) => request.method === "diagnostics.capture.stop"), false);
  assert.equal(result.took, 100);
  assert.deepEqual(s.recordingNotes,
    ["the recording of the drag did not start: a recording takes one still each refresh, and host.window.refreshRate is null"]);
});

test("a captured drag whose reply names no recorded window tells it", async (t) => {
  const s = dragSession(t, { until: 104, ticks: every(4, 92, 8), dragWindow: null });
  await drag(s, gapPlan, { capture: true });
  assert.equal(s.recordingNotes.length, 1);
  assert.match(s.recordingNotes[0], /: the drag reply of a window recording names the recorded window null, not a window number$/);
});

test("a captured drag whose stop names another window than its reply tells it", async (t) => {
  for (const window of [null, 8]) {
    const s = dragSession(t, { until: 104, ticks: every(4, 92, 8), window });
    await drag(s, gapPlan, { capture: true });
    assert.equal(s.recordingNotes.length, 1);
    assert.match(s.recordingNotes[0],
      new RegExp(`: the stop reply names the recorded window ${window}, not the window 7 that the recording records$`));
  }
});

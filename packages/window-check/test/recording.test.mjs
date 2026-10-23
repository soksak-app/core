import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { drag, finishSession, Session } from "../app.mjs";

/**
 * A connection that imitates a host with one recording. stop takes the recording and then fails when stopFails is set.
 * Without a recording, it rejects with `no capture is running` like the host.
 */
function fakeClient(directory, { stopFails = false, missingCallbackStatus = false } = {}) {
  const requests = [];
  let running = null;
  const captures = join(directory, "logs", "captures");
  mkdirSync(captures, { recursive: true });
  writeFileSync(join(directory, "logs", "host-1-1.jsonl"),
    `${JSON.stringify({ ts_us: 1791000000000000, seq: 1, level: "info", layer: "host", event: "log.open", fields: { schema: 2 } })}\n`);
  return {
    endpoint: { pid: process.pid },
    requests,
    request: async (method, params) => {
      requests.push({ method, ...params });
      if (method === "diagnostics.capture.start") {
        running = join(captures, `capture-${requests.length}`);
        mkdirSync(running);
        return { frames: running };
      }
      if (method === "diagnostics.capture.stop") {
        if (!running) throw new Error("no capture is running");
        const frames = running;
        running = null;
        if (stopFails) throw new Error("layout trace failed");
        const callbackStatus = join(frames, "callback-status.jsonl");
        if (!missingCallbackStatus) writeFileSync(callbackStatus, "{\"sequence\":1,\"status\":0,\"displayTime\":\"123\"}\n");
        return { frames, callbackStatus, count: 2, limited: false, longestGap: 16 };
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
  assert.equal(client.requests[0].display, true);
  await assert.rejects(recording.stop({ after: 5 }), /layout trace failed/);
  await assert.rejects(cleanUp(s), /1 recording failed: .*layout trace failed/);
  assert.equal(stops(client).length, 1, "the cleanup sent another stop after one was sent");
  assert.equal(existsSync(recording.frames), true, "the failed recording folder was not preserved");
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
    if (method === "diagnostics.drag") return { frames, took: 100, asked: 100 };
    if (method === "diagnostics.capture.stop") return { frames, callbackStatus: join(frames, "callback-status.jsonl"),
      count: 1, limited: false, longestGap: 16 };
    throw new Error(`unexpected ${method}`);
  };
  const result = await drag({ diagnostic() {} }, s,
    { axis: "x", line: 0, dx: 10, dy: 0, ms: 100, times: 1 }, { capture: true });
  assert.equal(result.frameDir, frames);
  assert.equal(s.recordings.has(frames), true, "the drag capture was not registered with the session");
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

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Session } from "../app.mjs";

/**
 * 녹화 하나를 가진 host 를 흉내 내는 연결. stop 은 녹화를 가져간 뒤 stopFails 이면 실패한다. 녹화가 없으면
 * host 처럼 `no capture is running` 으로 거부한다.
 */
function fakeClient(directory, { stopFails = false } = {}) {
  const requests = [];
  let running = null;
  return {
    requests,
    request: async (method, params) => {
      requests.push({ method, ...params });
      if (method === "diagnostics.capture.start") {
        running = join(directory, `capture-${requests.length}`);
        mkdirSync(running);
        return { frames: running };
      }
      if (method === "diagnostics.capture.stop") {
        if (!running) throw new Error("no capture is running");
        running = null;
        if (stopFails) throw new Error("layout trace failed");
        return { count: 2, limited: false, longestGap: 16 };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

const app = { name: "fixture" };
const stops = (client) => client.requests.filter((request) => request.method === "diagnostics.capture.stop");
const cleanUp = async (s) => { for (const clean of s.cleanups.reverse()) await clean(); };

test("a recording whose stop fails reports that stop's error and sends no second stop", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory, { stopFails: true });
  const s = new Session(app, client);
  const recording = await s.record({ display: true });
  assert.equal(client.requests[0].display, true);
  await assert.rejects(recording.stop({ after: 5 }), /layout trace failed/);
  await cleanUp(s);
  assert.equal(stops(client).length, 1, "the cleanup sent another stop after one was sent");
  assert.equal(existsSync(recording.frames), false, "the recording folder stayed");
});

test("a recording that the check did not stop is stopped and removed by the cleanup", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory);
  const s = new Session(app, client);
  const recording = await s.record();
  await cleanUp(s);
  assert.deepEqual(stops(client).map(({ after }) => after), [0]);
  assert.equal(existsSync(recording.frames), false, "the recording folder stayed");
});

test("a stopped recording is removed by the cleanup without another stop", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fakeClient(directory);
  const s = new Session(app, client);
  const recording = await s.record();
  const stopped = await recording.stop({ after: 7 });
  assert.equal(stopped.count, 2);
  await assert.rejects(recording.stop({ after: 8 }), /stop was already sent/);
  await cleanUp(s);
  assert.equal(stops(client).length, 1);
  assert.equal(existsSync(recording.frames), false, "the recording folder stayed");
});

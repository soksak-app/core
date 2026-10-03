import assert from "node:assert/strict";
import test from "node:test";

import { Session } from "../app.mjs";

/** 요청을 기록하고, fail 이 돌려준 코드로 입력을 실패시키는 연결. */
function fakeClient(fail = () => null) {
  const requests = [];
  const messages = { 1005: "the document did not receive the input within 2000 ms", 1007: "AppKit reports a nonzero NSEvent.pressedMouseButtons mask" };
  return {
    requests,
    request: async (method, params) => {
      requests.push({ method, ...params });
      const code = method === "input.pointer" ? fail(params) : null;
      if (code !== null) throw Object.assign(new Error(messages[code]), { code });
      return null;
    },
  };
}

const app = { name: "fixture" };
const open = (s) => [...(s.presses?.values() ?? [])];

test("a check session releases every press it left open", async () => {
  const client = fakeClient();
  const s = new Session(app, client);
  await s.pointer(10, 20, "down");
  await s.on("second").pointer(30, 40, "down", { button: "right" });
  await s.pointer(5, 6, "down", { button: "right" });
  await s.pointer(5, 6, "up", { button: "right" });
  assert.deepEqual(open(s), [
    { window: "main", x: 10, y: 20, button: "left" },
    { window: "second", x: 30, y: 40, button: "right" },
  ]);
  await s.releasePresses();
  assert.deepEqual(open(s), []);
  assert.deepEqual(client.requests.slice(-2), [
    { method: "input.pointer", window: "main", x: 10, y: 20, phase: "up", button: "left" },
    { method: "input.pointer", window: "second", x: 30, y: 40, phase: "up", button: "right" },
  ]);
});

test("a refused release keeps the press open and the session reports it", async () => {
  const client = fakeClient((params) => (params.phase === "up" ? 1007 : null));
  const s = new Session(app, client);
  await s.pointer(10, 20, "down");
  await assert.rejects(s.pointer(10, 20, "up"), /pressedMouseButtons/);
  assert.deepEqual(open(s), [{ window: "main", x: 10, y: 20, button: "left" }]);
  await assert.rejects(s.releasePresses(), /the synthetic left press at 10,20 in main stayed open: .*pressedMouseButtons/);
});

test("a press or release that the document received late still changes the open presses", async () => {
  const client = fakeClient(() => 1005);
  const s = new Session(app, client);
  await assert.rejects(s.pointer(10, 20, "down"), /did not receive/);
  assert.deepEqual(open(s), [{ window: "main", x: 10, y: 20, button: "left" }]);
  await assert.rejects(s.pointer(10, 20, "up"), /did not receive/);
  assert.deepEqual(open(s), []);
});

import assert from "node:assert/strict";
import test from "node:test";

import { Session } from "../app.mjs";

/**
 * 요청을 기록하고, fail 이 돌려준 코드로 입력을 실패시키는 연결. host.buttons 는 buttons 값이며 press 가 바꾸고
 * 감시자에게 알린다. 감시는 알림으로만 끝나고 시간 제한을 쓰지 않는다.
 */
function fakeClient(fail = () => null) {
  const requests = [];
  const watches = new Set();
  const messages = {
    1005: "the document did not receive the input within 2000 ms",
    1007: "AppKit reports NSEvent.pressedMouseButtons mask 0x1 while com.apple.finder (pid 667) is frontmost",
  };
  const client = {
    requests,
    buttons: { mask: 0 },
    request: async (method, params) => {
      requests.push({ method, ...params });
      const code = method === "input.pointer" ? fail(params, client.buttons) : null;
      if (code !== null) throw Object.assign(new Error(messages[code]), { code });
      return null;
    },
    watch: (window, name, predicate) => new Promise((resolve, reject) => {
      if (name !== "host.buttons") {
        reject(new Error(`the fake watches only host.buttons, not ${name}`));
        return;
      }
      requests.push({ method: "status.watch", window, name });
      const watch = { predicate, resolve };
      if (predicate(client.buttons)) resolve(client.buttons);
      else watches.add(watch);
    }),
    /** 사람이 버튼을 누르거나 떼어 host.buttons 가 바뀐 것을 알린다. */
    press(mask) {
      client.buttons = { mask };
      for (const watch of [...watches]) {
        if (!watch.predicate(client.buttons)) continue;
        watches.delete(watch);
        watch.resolve(client.buttons);
      }
    },
  };
  return client;
}

/** 대기 중인 promise 의 연속을 모두 실행한다. 시간을 기다리지 않는다. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** AppKit 이 버튼을 보고하는 동안 누름과 뗌을 거부하는 host. */
const heldRefuses = (params, buttons) => ((params.phase === "down" || params.phase === "up") && buttons.mask !== 0 ? 1007 : null);

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
  assert.deepEqual(client.requests.filter((request) => request.method === "input.pointer").slice(-2), [
    { method: "input.pointer", window: "main", x: 10, y: 20, phase: "up", button: "left" },
    { method: "input.pointer", window: "second", x: 30, y: 40, phase: "up", button: "right" },
  ]);
});

test("a refused release keeps the press open until the held button is released", async (t) => {
  // 시간 제한이 진행을 만들지 못하게 시간 함수를 멈춘다. 정리는 host.buttons 의 알림으로만 진행한다.
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const client = fakeClient(heldRefuses);
  const s = new Session(app, client);
  await s.pointer(10, 20, "down");
  client.press(0x1);
  // 거부된 사건이 누름인지 뗌인지는 열린 누름이 남는지를 정하므로, 오류가 단계와 자리를 밝힌다.
  await assert.rejects(s.pointer(10, 20, "up"), (error) => error.code === 1007 &&
    /^input\.pointer up of the left button at 10,20 in main: AppKit reports NSEvent\.pressedMouseButtons mask 0x1/.test(error.message));
  assert.deepEqual(open(s), [{ window: "main", x: 10, y: 20, button: "left" }]);
  const sent = client.requests.length;
  let ended = false;
  let released;
  const release = s.releasePresses().then((lines) => { ended = true; released = lines; });
  await settle();
  assert.equal(ended, false, "the cleanup ended while the button was held");
  assert.deepEqual(client.requests.slice(sent), [{ method: "status.watch", window: "main", name: "host.buttons" }],
    "the cleanup sent a release while host.buttons reported a held button");
  client.press(0);
  await release;
  // 정리가 끝낸 누름은 검사의 진단으로 남아 창 실행의 출력에서 뗌 대기가 실행됐음을 보인다.
  assert.equal(released.length, 1);
  assert.match(released[0], /^released open press: left at 10,20 in main after host\.buttons reported mask 0 \(waited \d+ms\)$/);
  assert.deepEqual(client.requests.slice(sent), [
    { method: "status.watch", window: "main", name: "host.buttons" },
    { method: "input.pointer", window: "main", x: 10, y: 20, phase: "up", button: "left" },
  ]);
  assert.deepEqual(open(s), []);
  // 끝난 누름 뒤의 같은 버튼 누름은 전달된다(1008 이 아니다).
  await s.pointer(10, 20, "down");
  await s.pointer(10, 20, "up");
});

test("a release that is refused after the buttons are released reports the press that stayed open", async () => {
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

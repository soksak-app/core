import assert from "node:assert/strict";
import test from "node:test";
import { createTranscript } from "../transcript.js";

/** 보낸 줄과, 각 전송을 끝내는 함수를 기록하는 가짜 전송. */
function fakeSend() {
  const started = [];
  const finish = [];
  const send = (line) => new Promise((resolve) => {
    started.push(line);
    finish.push(resolve);
  });
  return { send, started, finish };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a line is not sent before the previous line has been delivered", async () => {
  const bridge = fakeSend();
  const transcript = createTranscript(bridge.send);
  transcript.set(true);
  transcript.record("overlayUpdate", { id: "settings" }, Promise.resolve(null));
  transcript.record("overlayPlace", { id: "settings" }, Promise.resolve({}));
  await settle();
  assert.deepEqual(bridge.started, ['host overlayUpdate {"id":"settings"} -> null']);
  bridge.finish[0]();
  await settle();
  assert.deepEqual(bridge.started, [
    'host overlayUpdate {"id":"settings"} -> null',
    'host overlayPlace {"id":"settings"} -> null',
  ]);
});

test("lines follow the order in which answers arrive", async () => {
  const bridge = fakeSend();
  const transcript = createTranscript(bridge.send);
  transcript.set(true);
  let answerFirst;
  transcript.record("first", null, new Promise((resolve) => { answerFirst = resolve; }));
  transcript.record("second", [1], Promise.resolve(2));
  await settle();
  bridge.finish[0]();
  answerFirst("done");
  await settle();
  bridge.finish[1]?.();
  await settle();
  assert.deepEqual(bridge.started, ["host second [1] -> 2", 'host first null -> "done"']);
});

test("a failed send does not stop later lines", async () => {
  const lines = [];
  const transcript = createTranscript((line) => {
    lines.push(line);
    return lines.length === 1 ? Promise.reject(new Error("closed")) : Promise.resolve();
  });
  transcript.set(true);
  transcript.record("a", null, Promise.resolve(null));
  transcript.record("b", null, Promise.resolve(null));
  await settle();
  await settle();
  assert.deepEqual(lines, ["host a null -> null", "host b null -> null"]);
});

test("nothing is recorded while recording is off or for failed calls", async () => {
  const bridge = fakeSend();
  const transcript = createTranscript(bridge.send);
  transcript.record("off", null, Promise.resolve(null));
  transcript.set(true);
  transcript.record("failed", null, Promise.reject(new Error("no")));
  await settle();
  assert.deepEqual(bridge.started, []);
});

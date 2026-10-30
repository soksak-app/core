import assert from "node:assert/strict";
import test from "node:test";
import { createTranscript, transcriptSender } from "../transcript.js";

/** A fake transport that records the lines sent and the function that ends each transmission. */
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

test("the sender passes the whole line of a call to the host call log with the action transcript and the page identity", async () => {
  const calls = [];
  const transcript = createTranscript(transcriptSender((name, request) => {
    calls.push({ name, request });
    return Promise.resolve(null);
  }, "page-1"));
  transcript.set(true);
  // The payload holds ": " inside a value and is longer than the record bound of 8192 bytes.
  const payload = { description: "Sets the state: on or off", text: "x".repeat(9000) };
  transcript.record("syncSurfaces", payload, Promise.resolve(null));
  await settle();
  assert.deepEqual(calls, [{ name: "log", request: { action: "transcript", page: "page-1", line: `host syncSurfaces ${JSON.stringify(payload)} -> null` } }]);
});

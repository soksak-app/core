import assert from "node:assert/strict";
import test from "node:test";
import { createTranscript, transcriptSender } from "../transcript.js";

/** A fake transport that records the lines sent and the function that ends each transmission. arrived(count) resolves when count lines have started. */
function fakeSend() {
  const started = [];
  const finish = [];
  let waits = [];
  const send = (line) => new Promise((resolve) => {
    started.push(line);
    finish.push(resolve);
    const ready = waits.filter((wait) => wait.count <= started.length);
    waits = waits.filter((wait) => wait.count > started.length);
    for (const wait of ready) wait.resolve();
  });
  const arrived = (count) => new Promise((resolve) => {
    if (started.length >= count) resolve();
    else waits.push({ count, resolve });
  });
  return { send, started, finish, arrived };
}

test("a line is not sent before the previous line has been delivered", async () => {
  const bridge = fakeSend();
  const transcript = createTranscript(bridge.send);
  transcript.set(true);
  transcript.record("overlayUpdate", { id: "settings" }, Promise.resolve(null));
  transcript.record("overlayPlace", { id: "settings" }, Promise.resolve({}));
  await bridge.arrived(1);
  assert.deepEqual(bridge.started, ['host overlayUpdate {"id":"settings"} -> null']);
  bridge.finish[0]();
  await bridge.arrived(2);
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
  await bridge.arrived(1);
  bridge.finish[0]();
  answerFirst("done");
  await bridge.arrived(2);
  bridge.finish[1]();
  await transcript.idle();
  assert.deepEqual(bridge.started, ["host second [1] -> 2", 'host first null -> "done"']);
});

test("a failed send does not stop later lines", async () => {
  const lines = [];
  let bSent;
  const bArrival = new Promise((resolve) => { bSent = resolve; });
  const transcript = createTranscript((line) => {
    lines.push(line);
    if (lines.length === 2) bSent();
    return lines.length === 1 ? Promise.reject(new Error("closed")) : Promise.resolve();
  });
  transcript.set(true);
  transcript.record("a", null, Promise.resolve(null));
  transcript.record("b", null, Promise.resolve(null));
  await bArrival;
  await transcript.idle();
  assert.deepEqual(lines, ["host a null -> null", "host b null -> null"]);
});

test("nothing is recorded while recording is off or for failed calls", async () => {
  const bridge = fakeSend();
  let reported;
  const failure = new Promise((resolve) => { reported = resolve; });
  const transcript = createTranscript(bridge.send, () => reported());
  transcript.record("off", null, Promise.resolve(null));
  transcript.set(true);
  transcript.record("failed", null, Promise.reject(new Error("no")));
  await failure;
  assert.deepEqual(bridge.started, []);
});

test("the sender passes the whole line of a call to the host call log with the action transcript and the start of the workbench", async () => {
  const calls = [];
  let called;
  const callArrival = new Promise((resolve) => { called = resolve; });
  const transcript = createTranscript(transcriptSender((name, request) => {
    calls.push({ name, request });
    called();
    return Promise.resolve(null);
  }, "start-1"));
  transcript.set(true);
  // The payload holds ": " inside a value and is longer than the record bound of 8192 bytes.
  const payload = { description: "Sets the state: on or off", text: "x".repeat(9000) };
  transcript.record("syncSurfaces", payload, Promise.resolve(null));
  await callArrival;
  assert.deepEqual(calls, [{ name: "log", request: { action: "transcript", start: "start-1", line: `host syncSurfaces ${JSON.stringify(payload)} -> null` } }]);
});

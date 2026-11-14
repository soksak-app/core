import assert from "node:assert/strict";
import test from "node:test";
import { host, selectPageWire } from "@soksak/runtime";
import { createTranscript, transcriptSender } from "../transcript.js";
import { drained } from "./support/drained.mjs";

// The lines go to the host call log with the action transcript over the page-wire host of a case (docs/spec/cases/page-wire/README.md).
// A held reply of the case keeps a transmission outstanding until the test releases it.
const START = "start-1";
const sender = () => transcriptSender(host.call, START);
/** The lines that the page sent to the host so far. */
const lines = (wire) => wire.calls.map(({ payload }) => payload.line);

test("a line is not sent before the previous line has been delivered", async () => {
  const wire = selectPageWire("transcript-order");
  const transcript = createTranscript(sender());
  transcript.set(true);
  transcript.record("overlayUpdate", { id: "settings" }, Promise.resolve(null));
  transcript.record("overlayPlace", { id: "settings" }, Promise.resolve({}));
  await drained();
  assert.deepEqual(lines(wire), ['host overlayUpdate {"id":"settings"} -> null']);
  wire.release();
  await transcript.idle();
  await drained();
  assert.deepEqual(lines(wire), [
    'host overlayUpdate {"id":"settings"} -> null',
    'host overlayPlace {"id":"settings"} -> null',
  ]);
  await transcript.idle();
  wire.finish();
});

test("lines follow the order in which answers arrive", async () => {
  const wire = selectPageWire("transcript-answer-order");
  const transcript = createTranscript(sender());
  transcript.set(true);
  let answerFirst;
  transcript.record("first", null, new Promise((resolve) => { answerFirst = resolve; }));
  transcript.record("second", [1], Promise.resolve(2));
  await drained();
  wire.release();
  answerFirst("done");
  await transcript.idle();
  await drained();
  await transcript.idle();
  assert.deepEqual(lines(wire), ["host second [1] -> 2", 'host first null -> "done"']);
  wire.finish();
});

test("a failed send does not stop later lines", async () => {
  const wire = selectPageWire("transcript-failed-send");
  const reported = [];
  const transcript = createTranscript(sender(), (error) => reported.push(error.message));
  transcript.set(true);
  transcript.record("a", null, Promise.resolve(null));
  transcript.record("b", null, Promise.resolve(null));
  await drained();
  await transcript.idle();
  await drained();
  await transcript.idle();
  assert.deepEqual(lines(wire), ["host a null -> null", "host b null -> null"]);
  assert.deepEqual(reported, ["closed"]);
  wire.finish();
});

test("nothing is recorded while recording is off or for failed calls", async () => {
  const wire = selectPageWire("transcript-off-failed");
  let reported;
  const failure = new Promise((resolve) => { reported = resolve; });
  const transcript = createTranscript(sender(), () => reported());
  transcript.record("off", null, Promise.resolve(null));
  transcript.set(true);
  transcript.record("failed", null, Promise.reject(new Error("no")));
  await failure;
  assert.deepEqual(wire.calls, []);
  wire.finish();
});

test("the sender passes the whole line of a call to the host call log with the action transcript and the start of the workbench", async () => {
  const wire = selectPageWire("transcript-whole-line");
  const transcript = createTranscript(transcriptSender(host.call, START));
  transcript.set(true);
  // The payload holds ": " inside a value and is longer than the record bound of 8192 bytes.
  const payload = { description: "Sets the state: on or off", text: "x".repeat(9000) };
  transcript.record("syncSurfaces", payload, Promise.resolve(null));
  await transcript.idle();
  await drained();
  await transcript.idle();
  assert.deepEqual(wire.calls, [{ name: "log", payload: { action: "transcript", start: "start-1", line: `host syncSurfaces ${JSON.stringify(payload)} -> null` } }]);
  wire.finish();
});

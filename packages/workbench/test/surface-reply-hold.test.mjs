import assert from "node:assert/strict";
import test from "node:test";
import { createSurfaceReplyHold } from "../surface-reply-hold.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/* 보낸 답과 각 전송을 끝내는 함수를 기록하는 가짜 전송. */
function fakeSend(name, sent) {
  let finish;
  const send = () => new Promise((resolve, reject) => {
    sent.push(name);
    finish = { resolve, reject };
  });
  return { send, finish: () => finish };
}

test("a held surface reply is sent only after the host reports the surface closed", async () => {
  const lines = [];
  const hold = createSurfaceReplyHold((line) => { lines.push(line); return Promise.resolve(); });
  const sent = [];
  hold.hold("tab-a");
  const reply = fakeSend("reply 7", sent);
  let answered = false;
  const result = hold.gate("tab-a", reply.send).then((value) => { answered = value; });
  await hold.held("tab-a");
  await settle();
  assert.deepEqual(sent, [], "the reply was sent while the surface was open");
  const closed = hold.closed("tab-a");
  assert.deepEqual(sent, ["reply 7"]);
  assert.deepEqual(lines, [], "the line was written before the host answered the reply");
  reply.finish().resolve("ok");
  await closed;
  await result;
  assert.equal(answered, "ok", "the caller did not receive the answer of the late reply");
  assert.deepEqual(lines, ['held exposure replies of surface "tab-a" were sent after the surface closed (1)']);
});

test("a held reply that the host refuses rejects to its caller and still writes the line", async () => {
  const lines = [];
  const hold = createSurfaceReplyHold((line) => { lines.push(line); return Promise.resolve(); });
  const sent = [];
  hold.hold("tab-a");
  const reply = fakeSend("reply 8", sent);
  const result = hold.gate("tab-a", reply.send);
  const closed = hold.closed("tab-a");
  reply.finish().reject(new Error("surface is not attached"));
  await assert.rejects(result, /surface is not attached/);
  await closed;
  assert.deepEqual(lines, ['held exposure replies of surface "tab-a" were sent after the surface closed (1)']);
});

test("a reply of another surface, or after the hold ended, is sent at once", async () => {
  const hold = createSurfaceReplyHold(() => Promise.resolve());
  const sent = [];
  hold.hold("tab-a");
  await hold.gate("tab-b", () => { sent.push("tab-b"); return Promise.resolve(); });
  await hold.closed("tab-a");
  await hold.gate("tab-a", () => { sent.push("tab-a"); return Promise.resolve(); });
  assert.deepEqual(sent, ["tab-b", "tab-a"]);
  assert.equal(await hold.closed("tab-a"), undefined, "a close of a surface without a hold did something");
});

test("held waits for a held reply and fails without a hold or when the surface closes first", async () => {
  const hold = createSurfaceReplyHold(() => Promise.resolve());
  assert.throws(() => hold.held("tab-a"), /^Error: exposure replies of surface "tab-a" are not held$/);
  hold.hold("tab-a");
  let waited = false;
  const waiting = hold.held("tab-a").then(() => { waited = true; });
  await settle();
  assert.equal(waited, false, "held answered before a reply was held");
  const reply = hold.gate("tab-a", () => Promise.resolve("ok"));
  await waiting;
  await hold.closed("tab-a");
  assert.equal(await reply, "ok");
  hold.hold("tab-b");
  const early = hold.held("tab-b");
  await hold.closed("tab-b");
  await assert.rejects(early, /^Error: surface "tab-b" closed before it held an exposure reply$/);
});

test("hold rejects an invalid surface and a second hold of the same surface", () => {
  const hold = createSurfaceReplyHold(() => Promise.resolve());
  for (const surface of [undefined, null, "", 3]) {
    assert.throws(() => hold.hold(surface), /^Error: diagnostics.surface.hold requires surface$/);
  }
  assert.throws(() => hold.held(""), /^Error: diagnostics.surface.held requires surface$/);
  hold.hold("tab-a");
  assert.throws(() => hold.hold("tab-a"), /^Error: exposure replies of surface "tab-a" are already held$/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createSurfaceReplyHold } from "../surface-reply-hold.js";

/* A fake transport that records the replies sent and the function that ends each transmission. */
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
  // The gate call runs in a microtask queued after the then of held. A held that resolved before any reply was held answers first.
  const order = [];
  const waiting = hold.held("tab-a").then(() => { order.push("held"); });
  let reply;
  queueMicrotask(() => {
    order.push("gate");
    reply = hold.gate("tab-a", () => Promise.resolve("ok"));
  });
  await waiting;
  assert.deepEqual(order, ["gate", "held"], "held answered before a reply was held");
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

test("a released surface sends its held replies in order and writes the line of the ended hold", async () => {
  const lines = [];
  const hold = createSurfaceReplyHold((line) => { lines.push(line); return Promise.resolve(); });
  const sent = [];
  hold.hold("tab-a");
  const first = fakeSend("reply 1", sent);
  const second = fakeSend("reply 2", sent);
  const answers = [hold.gate("tab-a", first.send), hold.gate("tab-a", second.send)];
  assert.deepEqual(sent, [], "a reply was sent while the surface was held");
  const released = hold.released("tab-a");
  assert.deepEqual(sent, ["reply 1", "reply 2"], "the release did not send the held replies in the order held");
  first.finish().resolve("one");
  assert.equal(await answers[0], "one");
  assert.deepEqual(lines, [], "the line was written before the host answered every reply");
  second.finish().resolve("two");
  await released;
  assert.deepEqual(await Promise.all(answers), ["one", "two"]);
  assert.deepEqual(lines, ['held exposure replies of surface "tab-a" were sent after their hold ended (2)']);
  await hold.gate("tab-a", () => { sent.push("after"); return Promise.resolve(); });
  assert.deepEqual(sent, ["reply 1", "reply 2", "after"], "a reply after the release was held");
  hold.hold("tab-a");
});

test("a release fails a waiting held and leaves a surface without a hold alone", async () => {
  const lines = [];
  const hold = createSurfaceReplyHold((line) => { lines.push(line); return Promise.resolve(); });
  assert.equal(await hold.released("tab-a"), undefined, "a release of a surface without a hold did something");
  hold.hold("tab-a");
  const waiting = hold.held("tab-a");
  await hold.released("tab-a");
  await assert.rejects(waiting, /^Error: the hold of surface "tab-a" ended before it held an exposure reply$/);
  assert.deepEqual(lines, ['held exposure replies of surface "tab-a" were sent after their hold ended (0)']);
});

test("the end of the page ends every hold before the reload", async () => {
  const lines = [];
  const hold = createSurfaceReplyHold((line) => { lines.push(line); return Promise.resolve(); });
  const sent = [];
  hold.hold("tab-a");
  hold.hold("tab-b");
  const replies = [
    hold.gate("tab-a", () => { sent.push("a"); return Promise.resolve(); }),
    hold.gate("tab-b", () => { sent.push("b"); return Promise.resolve(); }),
  ];
  await hold.endAll();
  await Promise.all(replies);
  assert.deepEqual(sent, ["a", "b"]);
  assert.deepEqual(lines.sort(), [
    'held exposure replies of surface "tab-a" were sent after their hold ended (1)',
    'held exposure replies of surface "tab-b" were sent after their hold ended (1)',
  ]);
  await hold.gate("tab-a", () => { sent.push("later"); return Promise.resolve(); });
  assert.deepEqual(sent, ["a", "b", "later"], "a hold remained after the end of the page");
});

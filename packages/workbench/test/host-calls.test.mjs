import assert from "node:assert/strict";
import test from "node:test";

import { settlingCalls } from "../host-calls.js";

test("settling waits for the calls already sent and sends no later call", async () => {
  const sent = [];
  const answers = [];
  const calls = settlingCalls((name) => {
    sent.push(name);
    return new Promise((resolve, reject) => answers.push({ resolve, reject }));
  });
  const first = calls.call("first");
  const second = calls.call("second");
  await Promise.resolve();
  let settled = false;
  calls.settle().then(() => { settled = true; });
  const later = calls.call("later");
  let laterEnded = false;
  later.then(() => { laterEnded = true; }, () => { laterEnded = true; });
  answers[0].resolve("one");
  assert.equal(await first, "one");
  await Promise.resolve();
  assert.equal(settled, false, "settling ended before every sent call was answered");
  answers[1].reject(new Error("refused"));
  await assert.rejects(second, /refused/);
  await calls.settle();
  assert.equal(settled, true);
  assert.deepEqual(sent, ["first", "second"], "a call after settling was sent");
  assert.equal(laterEnded, false, "a call after settling ended");
});

test("settling without pending calls ends at once", async () => {
  const calls = settlingCalls(() => Promise.resolve(null));
  await calls.settle();
});

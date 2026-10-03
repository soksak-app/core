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

test("a call with a number that JSON cannot carry is refused before it is sent", async () => {
  const sent = [];
  const calls = settlingCalls((name, arg) => {
    sent.push([name, arg]);
    return Promise.resolve(null);
  });
  await assert.rejects(calls.call("syncSurfaces", { surfaces: [{ id: "a", x: 0, y: Number.NaN }] }),
    { name: "TypeError", message: "host call syncSurfaces: surfaces[0].y is NaN, which JSON sends as null" });
  await assert.rejects(calls.call("overlayPlace", { rect: { w: Infinity } }),
    { name: "TypeError", message: "host call overlayPlace: rect.w is Infinity, which JSON sends as null" });
  await assert.rejects(calls.call("waitPresented", -Infinity),
    { name: "TypeError", message: "host call waitPresented: the argument is -Infinity, which JSON sends as null" });
  await calls.call("syncSurfaces", { surfaces: [{ id: "a", x: 0, y: 1.5, hidden: null }] });
  assert.deepEqual(sent.map(([name]) => name), ["syncSurfaces"], "a call with a non-finite number was sent");
  await calls.settle();
});

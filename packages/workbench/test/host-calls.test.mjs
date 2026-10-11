import assert from "node:assert/strict";
import test from "node:test";

import { callEvent, observeHostCalls, settlingCalls } from "../host-calls.js";

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

test("an observer sees every call with its arguments, its duration and its outcome", async () => {
  const seen = [];
  observeHostCalls((call) => seen.push(call));
  const calls = settlingCalls((name) => (name === "bad" ? Promise.reject(new Error("refused")) : Promise.resolve("done")));
  await calls.call("good", { a: 1 });
  await assert.rejects(calls.call("bad"), /refused/);
  await assert.rejects(calls.call("nan", { x: NaN }), /NaN/);
  observeHostCalls(null);
  await calls.call("unobserved");
  assert.deepEqual(seen.map(({ name, args, ok, error }) => ({ name, args, ok, error })), [
    { name: "good", args: [{ a: 1 }], ok: true, error: undefined },
    { name: "bad", args: [], ok: false, error: "refused" },
    { name: "nan", args: [{ x: NaN }], ok: false, error: "host call nan: x is NaN, which JSON sends as null" },
  ]);
  for (const { micros } of seen) assert.ok(Number.isInteger(micros) && micros >= 0, `duration ${micros}`);
});

// An array whose reads are counted, to show how much of a value the event reads before it cuts.
function countedArray(length) {
  const reads = { count: 0 };
  const array = new Proxy(new Array(length).fill(1), {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads.count += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return { array, reads };
}

test("the arguments of a call are cut while they are serialized, not after the whole value is", () => {
  const { array, reads } = countedArray(1_000_000);
  const { fields } = callEvent({ name: "big", args: [array], micros: 1, ok: true });
  assert.equal(fields.truncated, true);
  assert.ok(Buffer.byteLength(fields.args) <= 1024, `${Buffer.byteLength(fields.args)} bytes`);
  assert.ok(fields.args.startsWith("[[1,1,1,"), fields.args.slice(0, 20));
  assert.ok(reads.count < 1024, `${reads.count} elements were read`);
});

test("the arguments of a call are cut at 1024 bytes on a character boundary", () => {
  const { fields } = callEvent({ name: "text", args: ["é".repeat(2000)], micros: 1, ok: true });
  assert.equal(fields.truncated, true);
  assert.ok(Buffer.byteLength(fields.args) <= 1024 && Buffer.byteLength(fields.args) >= 1022, `${Buffer.byteLength(fields.args)} bytes`);
  assert.equal(fields.args.includes("\ufffd"), false);
  const exact = callEvent({ name: "text", args: ["a".repeat(1020)], micros: 1, ok: true }).fields;
  assert.equal(Buffer.byteLength(exact.args), 1024);
  assert.equal(exact.truncated, false);
});

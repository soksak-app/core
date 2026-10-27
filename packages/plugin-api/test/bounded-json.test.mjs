// The bound on text that an event carries (docs/spec/logging.md#bounds): a value is cut while it is serialized, and text that
// fits is the text JSON.stringify writes.
import assert from "node:assert/strict";
import test from "node:test";

import { boundedJson, byteLength, cutBytes } from "../bounded-json.js";

test("text that fits is the text of JSON.stringify", () => {
  const cycle = {};
  cycle.self = cycle;
  const values = [
    null, true, 12, -0.5, 1e21, NaN, Infinity, "plain", 'quote " and \\ and \n and   and \ud800', "é€😀",
    [], {}, [1, "a", null, undefined, () => 1, Symbol("s")], { a: 1, b: undefined, c: () => 1, d: Symbol("s"), e: [{ f: null }] },
    { toJSON: () => ({ replaced: true }) }, new Date(0), new Number(3), new String("boxed"), new Boolean(false),
    new Map([[1, 2]]), new Set([1]), new Uint8Array([1, 2, 3]), { nested: { deeper: { deepest: [1, [2, [3]]] } } },
    { [Symbol("hidden")]: 1, visible: 2 },
  ];
  for (const value of values) {
    const want = JSON.stringify(value);
    const got = boundedJson(value, 4096);
    assert.equal(got.text, want, String(want));
    assert.equal(got.truncated, false);
  }
  assert.throws(() => boundedJson(cycle, 4096), { name: "TypeError", message: /circular/ });
  assert.throws(() => boundedJson({ n: 1n }, 4096), { name: "TypeError", message: /BigInt/ });
  assert.equal(boundedJson(undefined, 16).text, undefined);
});

test("a long value is a prefix of its text, cut at the bound", () => {
  const value = { list: Array.from({ length: 5000 }, (_, i) => i), text: "x".repeat(100000) };
  const full = JSON.stringify(value);
  for (const limit of [1, 2, 7, 64, 1024]) {
    const got = boundedJson(value, limit);
    assert.equal(got.text, full.slice(0, limit));
    assert.equal(got.truncated, true);
  }
  const exact = boundedJson([1, 2, 3], 7);
  assert.deepEqual(exact, { text: "[1,2,3]", truncated: false });
  assert.deepEqual(boundedJson([1, 2, 3], 6), { text: "[1,2,3", truncated: true });
});

test("the walk stops at the bound and reads a bounded part of a large value", () => {
  let reads = 0;
  const wide = new Proxy(new Array(2_000_000).fill(7), {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  let keys = 0;
  const many = new Proxy({}, {
    ownKeys: () => Array.from({ length: 100 }, (_, i) => `k${i}`),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: 1 }),
    get: () => { keys += 1; return "v".repeat(100); },
  });
  assert.equal(boundedJson(wide, 256).truncated, true);
  assert.ok(reads <= 256, `${reads} elements read`);
  assert.equal(boundedJson(many, 256).truncated, true);
  assert.ok(keys <= 10, `${keys} members read`);
});

test("a cut never splits a character and stays within the bytes", () => {
  for (const limit of [1, 2, 3, 4, 5, 10, 11]) {
    for (const text of ["é".repeat(20), "€".repeat(20), "😀".repeat(20), "a€😀é".repeat(5)]) {
      const got = cutBytes(text, limit);
      assert.ok(byteLength(got.text) <= limit, `${limit}: ${byteLength(got.text)}`);
      assert.equal(got.text, text.slice(0, got.text.length));
      assert.equal(got.truncated, true);
      assert.ok(limit - byteLength(got.text) < 4, `${limit}: ${byteLength(got.text)} leaves room for another character`);
    }
  }
  assert.deepEqual(cutBytes("é€😀", 9), { text: "é€😀", truncated: false });
  assert.equal(byteLength("é€😀\ud800"), 2 + 3 + 4 + 3);
});

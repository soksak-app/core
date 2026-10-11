// The bounds of the values that the page produces (docs/spec/logging.md#bounds): the text and the place of a record, the
// fields of an event of a plugin and the bytes of the queue are cut or refused by the page, before the host receives them.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { settled } from "./support/records.mjs";

const calls = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, payload) => { calls.push({ name, payload }); },
} } });
const { reportRecord, emitEvent } = await import("../page-log.js");

const events = () => calls.filter(({ name }) => name === "log").flatMap(({ payload }) => payload.events);

test("the text and the place of a record are cut at their bounds, and the event says truncated", async () => {
  calls.length = 0;
  await reportRecord("error", `${"p".repeat(3000)}: ${"é".repeat(10000)}`);
  const [event] = events();
  assert.equal(event.fields.truncated, true);
  assert.ok(Buffer.byteLength(event.fields.text) <= 8192 && Buffer.byteLength(event.fields.text) >= 8190, `${Buffer.byteLength(event.fields.text)} bytes`);
  assert.ok(Buffer.byteLength(event.fields.where) <= 1024, `${Buffer.byteLength(event.fields.where)} bytes`);
  calls.length = 0;
  await reportRecord("info", "short: text");
  assert.deepEqual(events()[0].fields, { where: "short", text: "text" });
});

test("the fields of an event of a plugin over 65536 bytes are replaced by their head while they are serialized", async () => {
  calls.length = 0;
  const reads = { count: 0 };
  const array = new Proxy(new Array(1_000_000).fill(1), {
    get(source, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads.count += 1;
      return Reflect.get(source, key, receiver);
    },
  });
  emitEvent("info", "plugin.test.big", { data: array });
  emitEvent("info", "plugin.test.small", { data: "x" });
  await settled();
  const [big, small] = events();
  assert.deepEqual(Object.keys(big.fields).sort(), ["head", "truncated"]);
  assert.equal(big.fields.truncated, true);
  assert.equal(Buffer.byteLength(big.fields.head), 4096);
  assert.ok(reads.count < 65536, `${reads.count} elements were read`);
  assert.deepEqual(small.fields, { data: "x" });
});

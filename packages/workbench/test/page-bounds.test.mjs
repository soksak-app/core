// The bounds of the values that the page produces (docs/spec/logging.md#bounds): the text and the place of a record, the
// fields of an event of a plugin and the bytes of the queue are cut or refused by the page, before the host receives them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPageWire } from "@soksak/runtime";
import { withoutClock } from "./support/records.mjs";

// The page-log module reads the host when it is imported, so a case is selected before the import (docs/spec/cases/page-wire/README.md).
// Each test selects its own case. The events below the level error are stored only in the debug state (docs/spec/settings.md,
// the section of core.settings.debug), so the state of every class is set to trace before the records are reported.
async function loadPageLog() {
  const { logGate } = await import("../log-gate.js");
  logGate.set({ lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" });
  return import("../page-log.js");
}

// The events of the batches that the page sent, without the anchor event of the first batch (workbench.log.clock).
const eventsOf = (wire) => wire.calls
  .filter(({ name, payload }) => name === "log" && payload.action === "batch")
  .flatMap(({ payload }) => withoutClock(payload).events);

test("the text and the place of a record are cut at their bounds, and the event says truncated", async () => {
  const wire = selectPageWire("page-bounds-record");
  const { reportRecord } = await loadPageLog();
  const events = () => eventsOf(wire);
  await reportRecord("error", `${"p".repeat(3000)}: ${"é".repeat(10000)}`);
  const [event] = events();
  assert.equal(event.fields.truncated, true);
  assert.ok(Buffer.byteLength(event.fields.text) <= 8192 && Buffer.byteLength(event.fields.text) >= 8190, `${Buffer.byteLength(event.fields.text)} bytes`);
  assert.ok(Buffer.byteLength(event.fields.where) <= 1024, `${Buffer.byteLength(event.fields.where)} bytes`);
  wire.calls.length = 0;
  await reportRecord("info", "short: text");
  assert.deepEqual(events()[0].fields, { where: "short", text: "text" });
  wire.finish();
});

test("the fields of an event of a plugin over 65536 bytes are replaced by their head while they are serialized", async () => {
  const wire = selectPageWire("page-bounds-plugin-event");
  const { emitEvent, flushEvents } = await loadPageLog();
  const reads = { count: 0 };
  const array = new Proxy(new Array(1_000_000).fill(1), {
    get(source, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads.count += 1;
      return Reflect.get(source, key, receiver);
    },
  });
  emitEvent("info", "plugin.test.big", { data: array });
  emitEvent("info", "plugin.test.small", { data: "x" });
  await flushEvents();
  const [big, small] = eventsOf(wire);
  assert.deepEqual(Object.keys(big.fields).sort(), ["head", "truncated"]);
  assert.equal(big.fields.truncated, true);
  assert.equal(Buffer.byteLength(big.fields.head), 4096);
  assert.ok(reads.count < 65536, `${reads.count} elements were read`);
  assert.deepEqual(small.fields, { data: "x" });
  wire.finish();
});
